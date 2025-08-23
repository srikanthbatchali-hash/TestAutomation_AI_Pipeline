// src/base/mining.ts
import * as vscode from "vscode";
import * as path from "path";
import { TextDecoder, TextEncoder } from "util";

/* ===========================
   Types
   =========================== */

export type StepDef = {
  keyword: string; // Given|When|Then|And|But
  text: string; // step text (single line, normalized)
  line: number; // 1-based line number
  dataTable?: string[][]; // optional data table (if present)
  docString?: string; // optional doc string (if present)
};

export type ScenarioDef = {
  id: string; // file:line
  file: string; // workspace-relative path
  name: string; // scenario name (may include <placeholders>)
  type: "Scenario" | "Scenario Outline";
  tags: string[];
  rawSteps: StepDef[];
  examplesHeader?: string[];
  examplesSample?: string[][]; // first few example rows
  nameExpansions?: string[]; // name expanded with sample rows (for matching)
  referencedBy?: string[]; // populated in 2nd pass
};

export type BaseScenariosIndex = {
  version: "1.2";
  generatedAt: string;
  totalScenarios: number;
  baseCount: number;
  nonBaseCount: number;
  baseScenarios: Array<{
    name: string; // canonical display name
    definitions: ScenarioDef[]; // unique defs (by id/content), all with referencedBy > 0
  }>;
};

export type BaseStepsIndex = {
  version: "1.1";
  generatedAt: string;
  totalUniqueTemplates: number;
  atomicSteps: Array<{
    keyword: string; // Given|When|Then|And|But
    template: string; // with "{arg1}", "{arg2}" for quoted args
    occurrences: number;
    sample: { file: string; line: number; scenarioId: string }[]; // up to 5
    rawSamples: string[]; // up to 5 raw step texts (un-templated)
    hasDataTable?: boolean;
    hasDocString?: boolean;
  }>;
};

export type ScenarioCallsIndex = {
  version: "1.0";
  generatedAt: string;
  totalCallers: number;
  edges: Array<{
    callerId: string;
    callerName: string;
    calls: Array<{
      calleeName: string; // normalized name extracted from call
      resolvedIds: string[]; // scenario ids that match that name (can be >1)
    }>;
  }>;
};

/* ===========================
   Utils
   =========================== */

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();

const EXCLUDE =
  "**/{target,build,dist,out,classes,reports,generated,node_modules,.git,.idea,.vscode,.qa-cache,coverage,tmp}/**";

const CALL_RE =
  /^\s*(Given|When|Then|And|But)\s+user\s+(performs|calls|executes|runs|invokes)\s+["'“”]?([^"'“”]+|<[^>]+>)["'“”]?/i;

const stopSpaces = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => stopSpaces(s.toLowerCase());
const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function writeCache(name: string, obj: any) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) throw new Error("No workspace open.");
  const dir = vscode.Uri.joinPath(ws, ".qa-cache");
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, name);
  await vscode.workspace.fs.writeFile(
    uri,
    enc.encode(JSON.stringify(obj, null, 2))
  );
}

async function findFeatureFiles(maxResults = 50000): Promise<vscode.Uri[]> {
  const uris = await vscode.workspace.findFiles(
    "**/*.feature",
    EXCLUDE,
    maxResults
  );
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const u of uris) {
    const k = u.fsPath;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/* ===========================
   Lightweight Gherkin parse
   =========================== */

async function parseFeatureFile(
  uri: vscode.Uri,
  wsRoot: vscode.Uri
): Promise<ScenarioDef[]> {
  const rel = path.normalize(path.relative(wsRoot.fsPath, uri.fsPath));
  const txt = dec.decode(await vscode.workspace.fs.readFile(uri));
  const lines = txt.split(/\r?\n/);

  const scenarios: ScenarioDef[] = [];
  let pendingTags: string[] = [];
  let cur: ScenarioDef | null = null;

  // Examples / tables
  let inExamples = false;
  let examplesHeader: string[] | undefined;
  let examplesRows: string[][] = [];

  // Data tables & doc strings for steps
  let lastStep: StepDef | null = null;
  let inDocString = false;
  let docStringDelimiter: string | null = null;

  const flushScenario = () => {
    if (!cur) return;

    // Outline name expansions using first few examples
    if (
      cur.type === "Scenario Outline" &&
      examplesHeader &&
      examplesRows.length
    ) {
      cur.examplesHeader = examplesHeader;
      cur.examplesSample = examplesRows.slice(0, 3);
      const expansions: string[] = [];
      for (const row of cur.examplesSample) {
        let name = cur.name;
        for (let i = 0; i < examplesHeader.length && i < row.length; i++) {
          const key = examplesHeader[i];
          const val = row[i];
          name = name.replace(
            new RegExp(`<\\s*${escapeReg(key)}\\s*>`, "gi"),
            val
          );
        }
        expansions.push(stopSpaces(name));
      }
      cur.nameExpansions = Array.from(new Set(expansions));
    }

    scenarios.push(cur);
    cur = null;

    // reset examples state
    inExamples = false;
    examplesHeader = undefined;
    examplesRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Doc string handling (""" or ``` or ```gherkin etc.)
    if (inDocString) {
      if (docStringDelimiter && line.startsWith(docStringDelimiter)) {
        inDocString = false;
        docStringDelimiter = null;
      } else if (lastStep) {
        lastStep.docString = (lastStep.docString ?? "") + raw + "\n";
      }
      continue;
    }

    // tags
    if (line.startsWith("@")) {
      pendingTags = line.split(/\s+/).filter(Boolean);
      continue;
    }

    // scenario header
    const scen = line.match(/^(Scenario Outline|Scenario):\s*(.+)$/i);
    if (scen) {
      if (cur) flushScenario();
      const type = scen[1].toLowerCase().startsWith("scenario outline")
        ? "Scenario Outline"
        : "Scenario";
      const name = stopSpaces(scen[2]);
      cur = {
        id: `${rel}:${i + 1}`,
        file: rel,
        name,
        type,
        tags: pendingTags.slice(),
        rawSteps: [],
      };
      pendingTags = [];
      inExamples = false;
      continue;
    }

    // Examples:
    if (/^Examples:/i.test(line)) {
      inExamples = true;
      examplesHeader = undefined;
      examplesRows = [];
      continue;
    }

    // Examples rows
    if (inExamples && /^\|/.test(line)) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => stopSpaces(c));
      if (!examplesHeader) examplesHeader = cells;
      else if (cells.length) examplesRows.push(cells);
      continue;
    }

    // Step line
    const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (stepMatch && cur) {
      const step: StepDef = {
        keyword: stepMatch[1],
        text: stopSpaces(stepMatch[2]),
        line: i + 1,
      };
      cur.rawSteps.push(step);
      lastStep = step;
      continue;
    }

    // Data table row (attached to last step)
    if (/^\|/.test(line) && lastStep) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => stopSpaces(c));
      lastStep.dataTable = lastStep.dataTable ?? [];
      lastStep.dataTable!.push(cells);
      continue;
    }

    // Doc string start
    const docStart = line.match(/^("""|```)/);
    if (docStart && lastStep) {
      inDocString = true;
      docStringDelimiter = docStart[1];
      lastStep.docString = "";
      continue;
    }

    // comments/blank – keep tags until scenario header
  }

  if (cur) flushScenario();
  return scenarios;
}

/* ===========================
   Graph & indices
   =========================== */

function buildNameIndex(defs: ScenarioDef[]): Map<string, ScenarioDef[]> {
  const byName = new Map<string, ScenarioDef[]>();
  for (const d of defs) {
    const names = [d.name, ...(d.nameExpansions ?? [])]
      .map(norm)
      .filter(Boolean);
    for (const n of Array.from(new Set(names))) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n)!.push(d);
    }
  }
  return byName;
}

function extractCalls(steps: StepDef[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const m = s.text.match(CALL_RE);
    if (!m) continue;
    const raw = m[3].trim();
    const cleaned = raw.replace(/^<\s*|\s*>$/g, ""); // strip <...>
    out.push(norm(cleaned));
  }
  return out;
}

function populateReferences(defs: ScenarioDef[]) {
  const byName = buildNameIndex(defs);
  // calleeId -> callers
  const refs = new Map<string, Set<string>>();
  for (const caller of defs) {
    const calls = extractCalls(caller.rawSteps);
    for (const cname of calls) {
      const cands = byName.get(cname);
      if (!cands) continue;
      for (const callee of cands) {
        if (!refs.has(callee.id)) refs.set(callee.id, new Set<string>());
        refs.get(callee.id)!.add(caller.id);
      }
    }
  }
  for (const d of defs)
    d.referencedBy = Array.from(refs.get(d.id) ?? new Set());
}

function contentKey(d: ScenarioDef): string {
  return JSON.stringify({
    type: d.type,
    steps: d.rawSteps.map((s) => `${s.keyword} ${s.text}`),
    examplesHeader: d.examplesHeader ?? [],
    examplesSample: (d.examplesSample ?? []).slice(0, 3),
  });
}

function dedupeByIdAndContent(defs: ScenarioDef[]): ScenarioDef[] {
  const byId = new Map<string, ScenarioDef>();
  for (const d of defs) if (!byId.has(d.id)) byId.set(d.id, d);

  const byContent = new Map<string, ScenarioDef>();
  for (const d of byId.values()) {
    const key = contentKey(d);
    if (!byContent.has(key)) byContent.set(key, d);
    else {
      // merge referencedBy
      const a = new Set(byContent.get(key)!.referencedBy ?? []);
      for (const r of d.referencedBy ?? []) a.add(r);
      byContent.get(key)!.referencedBy = Array.from(a);
    }
  }
  return Array.from(byContent.values());
}

/* ===========================
   Base-steps catalog (atomic)
   =========================== */

function stepTemplateFromText(text: string): {
  template: string;
  rawArgs: string[];
} {
  // Replace quoted segments with {argN}
  const args = Array.from(text.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  let idx = 1;
  const template = text.replace(/"([^"]+)"/g, () => `"{arg${idx++}}"`);
  return { template, rawArgs: args };
}

function buildBaseStepsIndex(allDefs: ScenarioDef[]): BaseStepsIndex {
  const counter = new Map<
    string,
    {
      keyword: string;
      template: string;
      occurrences: number;
      sample: { file: string; line: number; scenarioId: string }[];
      rawSamples: string[];
      hasDataTable?: boolean;
      hasDocString?: boolean;
    }
  >();

  for (const d of allDefs) {
    for (const s of d.rawSteps) {
      const { template } = stepTemplateFromText(s.text);
      const key = `${s.keyword}:${template}`;
      if (!counter.has(key)) {
        counter.set(key, {
          keyword: s.keyword,
          template,
          occurrences: 0,
          sample: [],
          rawSamples: [],
          hasDataTable: false,
          hasDocString: false,
        });
      }
      const rec = counter.get(key)!;
      rec.occurrences += 1;
      if (rec.sample.length < 5)
        rec.sample.push({ file: d.file, line: s.line, scenarioId: d.id });
      if (rec.rawSamples.length < 5) rec.rawSamples.push(s.text);
      if (s.dataTable && s.dataTable.length) rec.hasDataTable = true;
      if (s.docString && s.docString.length) rec.hasDocString = true;
    }
  }

  const atomicSteps = Array.from(counter.values()).sort(
    (a, b) =>
      b.occurrences - a.occurrences || a.template.localeCompare(b.template)
  );

  return {
    version: "1.1",
    generatedAt: new Date().toISOString(),
    totalUniqueTemplates: atomicSteps.length,
    atomicSteps,
  };
}

/* ===========================
   Scenario-calls index
   =========================== */

function buildScenarioCallsIndex(allDefs: ScenarioDef[]): ScenarioCallsIndex {
  const byName = buildNameIndex(allDefs);
  const edges: ScenarioCallsIndex["edges"] = [];

  for (const caller of allDefs) {
    const calls = extractCalls(caller.rawSteps);
    if (!calls.length) continue;

    const uniqueCalls = Array.from(new Set(calls));
    const rows = uniqueCalls.map((cname) => {
      const cands = byName.get(cname) ?? [];
      return {
        calleeName: cname,
        resolvedIds: Array.from(new Set(cands.map((c) => c.id))),
      };
    });

    edges.push({
      callerId: caller.id,
      callerName: caller.name,
      calls: rows,
    });
  }

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    totalCallers: edges.length,
    edges,
  };
}

/* ===========================
   Base-scenarios index
   =========================== */

function buildBaseScenariosIndex(allDefs: ScenarioDef[]): BaseScenariosIndex {
  // strict base policy: referencedOnly
  const referencedOnly = allDefs.filter(
    (d) => (d.referencedBy?.length ?? 0) > 0
  );

  // group by normalized name
  const groups = new Map<string, ScenarioDef[]>();
  for (const d of referencedOnly) {
    const key = norm(d.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  const baseScenarios: BaseScenariosIndex["baseScenarios"] = [];
  for (const [lowerName, defs] of groups) {
    const unique = dedupeByIdAndContent(defs);
    const displayName = unique[0]?.name ?? lowerName;
    baseScenarios.push({ name: displayName, definitions: unique });
  }
  baseScenarios.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: "1.2",
    generatedAt: new Date().toISOString(),
    totalScenarios: allDefs.length,
    baseCount: referencedOnly.length,
    nonBaseCount: allDefs.length - referencedOnly.length,
    baseScenarios,
  };
}

/* ===========================
   Entry – build & save all
   =========================== */

export async function buildAndSaveBaseArtifacts(): Promise<{
  baseIndex: BaseScenariosIndex;
  baseSteps: BaseStepsIndex;
  scenarioCalls: ScenarioCallsIndex;
}> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) throw new Error("No workspace folder open.");

  // 1) Find feature files (exclude target/dist/etc.)
  const uris = await findFeatureFiles();

  // 2) Parse all scenarios
  const allDefs: ScenarioDef[] = [];
  for (const u of uris) {
    try {
      const defs = await parseFeatureFile(u, ws);
      allDefs.push(...defs);
    } catch (e) {
      console.warn(`Failed to parse ${u.fsPath}:`, e);
    }
  }

  // 3) Populate references (second pass)
  populateReferences(allDefs);

  // 4) Build indices
  const baseIndex = buildBaseScenariosIndex(allDefs);
  const baseSteps = buildBaseStepsIndex(allDefs);
  const scenarioCalls = buildScenarioCallsIndex(allDefs);

  // 5) Write caches
  await writeCache("base-scenarios.index.json", baseIndex);
  await writeCache("base-steps.index.json", baseSteps);
  await writeCache("scenario-calls.index.json", scenarioCalls);

  // 6) Optional diagnostics: which were excluded from base
  const nonBase = allDefs.filter((d) => (d.referencedBy?.length ?? 0) === 0);
  const diag = {
    totalCandidates: nonBase.length,
    note: "Scenarios not referenced by any other scenario (excluded from base index).",
    samples: nonBase
      .slice(0, 100)
      .map(({ id, file, name, tags }) => ({ id, file, name, tags })),
  };
  await writeCache("candidates.base.json", diag);

  return { baseIndex, baseSteps, scenarioCalls };
}
