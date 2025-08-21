import * as vscode from "vscode";
import * as path from "path";
import { TextDecoder } from "util";
import {
  CompositeStepIndex,
  ParsedScenario,
  ParsedStep,
  ExamplesTable,
  DataTable,
  DocString,
  ParamRef,
} from "./types";

const decoder = new TextDecoder("utf-8");

// --------- Public API ---------
export async function buildCompositeStepIndex(opts?: {
  glob?: string;
  includeExpanded?: boolean; // expand Scenario Outlines into concrete variants
  maxFiles?: number;
}): Promise<CompositeStepIndex> {
  const glob = opts?.glob ?? "**/*.feature";
  const files = await vscode.workspace.findFiles(
    glob,
    "**/node_modules/**",
    opts?.maxFiles ?? 10000
  );

  const scenarios: ParsedScenario[] = [];
  for (const f of files) {
    const buf = await vscode.workspace.fs.readFile(f);
    const txt = decoder.decode(buf);
    const parsed = parseFeatureFile(txt, vscode.workspace.asRelativePath(f));
    scenarios.push(...parsed);
  }

  // Optionally compute expansions
  if (opts?.includeExpanded) {
    scenarios.forEach((s) => {
      if (s.type === "Scenario Outline" && s.examples.length > 0) {
        s.expansions = expandScenarioOutline(s);
      }
    });
  }

  // Build lookups
  const byName: Record<string, ParsedScenario[]> = {};
  const byTag: Record<string, ParsedScenario[]> = {};
  for (const s of scenarios) {
    const key = s.name.trim().toLowerCase();
    (byName[key] ??= []).push(s);
    for (const t of s.tags) {
      (byTag[t] ??= []).push(s);
    }
  }

  return {
    indexVersion: "1.0",
    generatedAt: new Date().toISOString(),
    scenarios,
    byName,
    byTag,
  };
}

// --------- Parser ---------

function parseFeatureFile(text: string, relPath: string): ParsedScenario[] {
  const lines = text.split(/\r?\n/);
  const scenarios: ParsedScenario[] = [];

  let currentTags: string[] = [];
  let inScenario = false;
  let inExamples = false;

  let sName = "";
  let sType: "Scenario" | "Scenario Outline" = "Scenario";
  let sLine = 0;
  let steps: ParsedStep[] = [];
  let examples: ExamplesTable[] = [];

  // helpers for step attachments
  let pendingStep: ParsedStep | null = null;
  let collectingDocString: DocString | null = null;
  let collectingTable: DataTable | null = null;

  const flushScenario = () => {
    if (!inScenario) return;
    // attach any trailing table/docstring
    finalizePendingStep();
    scenarios.push({
      name: sName.trim(),
      tags: currentTags.slice(),
      type: sType,
      file: relPath,
      id: `${relPath}:${sLine}`,
      line: sLine,
      steps: steps.slice(),
      examples: examples.slice(),
    });
    // reset
    inScenario = false;
    sName = "";
    sType = "Scenario";
    sLine = 0;
    steps = [];
    examples = [];
    currentTags = [];
    pendingStep = null;
    collectingDocString = null;
    collectingTable = null;
    inExamples = false;
  };

  const finalizePendingStep = () => {
    if (pendingStep) {
      if (collectingDocString) {
        pendingStep.docString = collectingDocString;
        collectingDocString = null;
      }
      if (collectingTable) {
        pendingStep.dataTable = collectingTable;
        collectingTable = null;
      }
      steps.push(pendingStep);
      pendingStep = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd(); // preserve left spaces for docstrings if needed
    const lineNum = i + 1;

    // Skip comments
    if (/^\s*#/.test(line)) {
      i++;
      continue;
    }

    // Tag line
    if (/^\s*@/.test(line)) {
      currentTags = line.split(/\s+/).filter((t) => t.startsWith("@"));
      i++;
      continue;
    }

    // Feature header: ignore
    if (/^\s*Feature\s*:/.i.test(line)) {
      i++;
      continue;
    }

    // Scenario/Scenario Outline
    const scenMatch = line.match(
      /^\s*(Scenario Outline|Scenario)\s*:\s*(.+)$/i
    );
    if (scenMatch) {
      // close previous scenario
      flushScenario();
      inScenario = true;
      sType = scenMatch[1].toLowerCase().includes("outline")
        ? "Scenario Outline"
        : "Scenario";
      sName = scenMatch[2].trim();
      sLine = lineNum;
      currentTags = currentTags; // already set by previous tag line if any
      i++;
      continue;
    }

    // Examples:
    const exMatch = line.match(/^\s*Examples\s*:/i);
    if (exMatch && inScenario) {
      // finalize any pending step
      finalizePendingStep();
      // parse one or multiple example tables
      const ex = readExamplesBlock(lines, i);
      examples.push(ex.table);
      i = ex.nextIndex;
      inExamples = true;
      continue;
    }

    // Steps
    const stepMatch = line.match(/^\s*(Given|When|Then|And|But)\s+(.*)$/i);
    if (stepMatch && inScenario) {
      // finalize previous step attachments
      finalizePendingStep();

      const keyword = stepMatch[1] as ParsedStep["keyword"];
      const text = stepMatch[2].trim();
      pendingStep = {
        keyword,
        text,
        line: lineNum,
        params: extractParams(text),
        dataTable: null,
        docString: null,
      };
      inExamples = false;
      i++;
      continue;
    }

    // DocString start/end: triple quotes """ or ``` (support both)
    if (inScenario && pendingStep && /^\s*("""|```)/.test(line)) {
      const fence = line.trim();
      if (!collectingDocString) {
        // start
        collectingDocString = {
          value: "",
          startLine: lineNum,
          endLine: lineNum,
        };
      } else {
        // end
        collectingDocString.endLine = lineNum;
      }
      i++;
      // collect inner lines until closing fence
      const start = i;
      while (i < lines.length && !lines[i].trim().startsWith(fence.trim())) {
        const valLine = lines[i];
        if (collectingDocString) {
          collectingDocString.value +=
            (collectingDocString.value ? "\n" : "") + valLine;
        }
        i++;
      }
      // consume closing fence
      if (i < lines.length) {
        collectingDocString!.endLine = i + 1;
        i++;
      }
      continue;
    }

    // DataTable rows (start with | ... |)
    if (inScenario && pendingStep && /^\s*\|.*\|\s*$/.test(line)) {
      if (!collectingTable) {
        collectingTable = {
          header: undefined,
          rows: [],
          startLine: lineNum,
          endLine: lineNum,
        };
      }
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (!collectingTable.header) {
        collectingTable.header = cells;
      } else {
        collectingTable.rows.push(cells);
      }
      collectingTable.endLine = lineNum;
      i++;
      continue;
    }

    // blank or anything else between content
    i++;
  }

  // flush last scenario
  flushScenario();
  return scenarios;
}

function extractParams(stepText: string): ParamRef {
  const angle = Array.from(stepText.matchAll(/<([^>]+)>/g)).map((m) => m[1]);
  const curly = Array.from(stepText.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
  return { angle, curly };
}

function readExamplesBlock(
  lines: string[],
  startIndex: number
): { table: ExamplesTable; nextIndex: number } {
  // Consume "Examples:" line
  let i = startIndex;
  const tagsAbove: string[] = collectInlineTagsAbove(lines, i);
  i++; // move past "Examples:"

  // Optional tags line directly under Examples:
  let exTags: string[] = [];
  if (i < lines.length && /^\s*@/.test(lines[i])) {
    exTags = lines[i]
      .trim()
      .split(/\s+/)
      .filter((t) => t.startsWith("@"));
    i++;
  }

  // Expect a header row
  const headerRow = readTableRow(lines, i);
  if (!headerRow) {
    return {
      table: {
        tags: [...tagsAbove, ...exTags],
        header: [],
        rows: [],
        startLine: startIndex + 1,
        endLine: startIndex + 1,
      },
      nextIndex: i + 1,
    };
  }
  const header = headerRow.cells;
  let startLine = headerRow.line;
  i = headerRow.nextIndex;

  // Read data rows
  const rows: Record<string, string>[] = [];
  while (true) {
    const row = readTableRow(lines, i);
    if (!row) break;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c]] = (row.cells[c] ?? "").trim();
    }
    rows.push(record);
    i = row.nextIndex;
  }
  const endLine = i > 0 ? i : startIndex + 1;

  return {
    table: {
      tags: [...tagsAbove, ...exTags],
      header,
      rows,
      startLine,
      endLine,
    },
    nextIndex: i,
  };
}

function collectInlineTagsAbove(lines: string[], idx: number): string[] {
  // Look upward for @tags directly above Examples:
  const tags: string[] = [];
  let i = idx - 1;
  while (i >= 0 && /^\s*$/.test(lines[i])) i--;
  if (i >= 0 && /^\s*@/.test(lines[i])) {
    tags.push(
      ...lines[i]
        .trim()
        .split(/\s+/)
        .filter((t) => t.startsWith("@"))
    );
  }
  return tags;
}

function readTableRow(
  lines: string[],
  start: number
): { cells: string[]; nextIndex: number; line: number } | null {
  if (start >= lines.length) return null;
  const m = lines[start].match(/^\s*\|(.+)\|\s*$/);
  if (!m) return null;
  const cells = m[1].split("|").map((c) => c.trim());
  let i = start + 1;
  return { cells, nextIndex: i, line: start + 1 };
}

// Expand Scenario Outline: returns concrete variants (name + steps with <angle> bound)
function expandScenarioOutline(
  s: ParsedScenario
): ParsedScenario["expansions"] {
  const exps: ParsedScenario["expansions"] = [];
  if (s.type !== "Scenario Outline" || s.examples.length === 0) return [];
  s.examples.forEach((exTable, exIdx) => {
    for (const row of exTable.rows) {
      const cloneSteps: ParsedStep[] = s.steps.map((st) => ({
        ...st,
        text: bindAngleParams(st.text, row),
        params: {
          angle: [], // resolved
          curly: [...st.params.curly],
        },
        // keep attachments as-is (they can still include placeholders)
        dataTable: st.dataTable
          ? { ...st.dataTable, rows: st.dataTable.rows.map((r) => r.slice()) }
          : undefined,
        docString: st.docString ? { ...st.docString } : undefined,
      }));
      exps!.push({
        name: bindAngleParams(s.name, row),
        steps: cloneSteps,
        exampleRow: { ...row },
        sourceExamplesIndex: exIdx,
      });
    }
  });
  return exps;
}

function bindAngleParams(text: string, row: Record<string, string>): string {
  return text.replace(/<([^>]+)>/g, (_, key) => row[key] ?? `<${key}>`);
}

// --------- Persist helper (optional) ---------
export async function saveCompositeIndex(
  idx: CompositeStepIndex,
  targetRel = ".qa-cache/composite-steps.index.json"
) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, targetRel);
  const enc = new TextEncoder();
  const bytes = enc.encode(JSON.stringify(idx, null, 2));
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, path.dirname(targetRel))
  );
  await vscode.workspace.fs.writeFile(uri, bytes);
}
