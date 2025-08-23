// src/base/mining.ts
import * as vscode from "vscode";
import * as path from "path";
import { TextDecoder, TextEncoder } from "util";
import { findFeatureFiles } from "../utils/findFeatureFiles";

export type StepDef = { keyword: string; text: string; line: number };
export type ScenarioDef = {
  id: string; // file:line
  file: string; // relative path
  name: string; // raw scenario name (may include <placeholders>)
  type: "Scenario" | "Scenario Outline";
  tags: string[];
  rawSteps: StepDef[];
  examplesHeader?: string[]; // header cells (if Outline)
  examplesSample?: string[][]; // first few example rows
  nameExpansions?: string[]; // scenario name expanded using sample rows
  referencedBy?: string[]; // filled in 2nd pass
};

export type BaseScenariosIndex = {
  version: "1.1";
  generatedAt: string;
  totalScenarios: number;
  baseCount: number;
  nonBaseCount: number;
  baseScenarios: Array<{
    name: string; // canonical display name
    definitions: ScenarioDef[]; // de-duped unique defs (by id/content)
  }>;
};

const CALL_RE =
  /^\s*(Given|When|Then|And|But)\s+user\s+(performs|calls|executes|runs|invokes)\s+["'“”]?([^"'“”]+|<[^>]+>)["'“”]?/i;

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();
const stopSpaces = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => stopSpaces(s.toLowerCase());

/** Parse a single .feature file into ScenarioDef[] (lightweight Gherkin parser). */
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
  let inExamples = false;
  let examplesHeader: string[] | undefined;
  let examplesRows: string[][] = [];

  const flushScenario = () => {
    if (!cur) return;
    // attach examples if any
    if (
      cur.type === "Scenario Outline" &&
      examplesHeader &&
      examplesRows.length
    ) {
      cur.examplesHeader = examplesHeader;
      cur.examplesSample = examplesRows.slice(0, 3);
      // produce a few expanded names for matching
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
    // reset examples area
    inExamples = false;
    examplesHeader = undefined;
    examplesRows = [];
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // tag lines
    if (line.startsWith("@")) {
      pendingTags = line.split(/\s+/).filter(Boolean);
      continue;
    }

    // Scenario / Scenario Outline
    const scenMatch = line.match(/^(Scenario Outline|Scenario):\s*(.+)$/i);
    if (scenMatch) {
      // end previous
      if (cur) flushScenario();

      const type = scenMatch[1].toLowerCase().startsWith("scenario outline")
        ? "Scenario Outline"
        : "Scenario";
      const name = stopSpaces(scenMatch[2]);
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

    // Examples table rows
    if (inExamples && /^\|/.test(line)) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => stopSpaces(c));
      if (!examplesHeader) {
        examplesHeader = cells;
      } else if (cells.length) {
        examplesRows.push(cells);
      }
      continue;
    }

    // Steps
    const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (stepMatch && cur) {
      cur.rawSteps.push({
        keyword: stepMatch[1],
        text: stopSpaces(stepMatch[2]),
        line: i + 1,
      });
      continue;
    }

    // Blank or comments reset pending tags
    if (!line || line.startsWith("#")) {
      pendingTags = pendingTags; // no-op, keep until next scenario
      continue;
    }
  }
  if (cur) flushScenario();
  return scenarios;
}

/** Escape regex meta for dynamic placeholders */
function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build name→defs index including expansions */
function buildNameIndex(defs: ScenarioDef[]) {
  const byName = new Map<string, ScenarioDef[]>();
  for (const d of defs) {
    const names = [d.name, ...(d.nameExpansions ?? [])]
      .map(norm)
      .filter((x) => x.length > 0);
    const uniq = Array.from(new Set(names));
    for (const n of uniq) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n)!.push(d);
    }
  }
  return byName;
}

/** Extract composite calls from a scenario's steps */
function extractCalls(steps: StepDef[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const m = s.text.match(CALL_RE);
    if (!m) continue;
    const raw = m[3].trim();
    // strip surrounding angle brackets if present
    const cleaned = raw.replace(/^<\s*|\s*>$/g, "");
    out.push(norm(cleaned));
  }
  return out;
}

/** Dedupe by id, then by content (merge referencedBy) */
function contentKey(d: ScenarioDef): string {
  return JSON.stringify({
    type: d.type,
    steps: d.rawSteps.map((s) => `${s.keyword} ${s.text}`),
    examplesHeader: d.examplesHeader ?? [],
    examplesSample: (d.examplesSample ?? []).slice(0, 3),
  });
}

function dedupeScenarioDefs(defs: ScenarioDef[]): ScenarioDef[] {
  // by id
  const byId = new Map<string, ScenarioDef>();
  for (const d of defs) {
    if (!byId.has(d.id)) byId.set(d.id, d);
  }
  // by content
  const byContent = new Map<string, ScenarioDef>();
  for (const d of byId.values()) {
    const key = contentKey(d);
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, d);
    } else {
      const a = new Set(existing.referencedBy ?? []);
      for (const r of d.referencedBy ?? []) a.add(r);
      existing.referencedBy = Array.from(a);
    }
  }
  return Array.from(byContent.values());
}

/** Populate referencedBy (callee <- caller ids) in a second pass */
function populateReferences(defs: ScenarioDef[]): Map<string, string[]> {
  const byName = buildNameIndex(defs);
  const refs = new Map<string, string[]>();

  for (const caller of defs) {
    const calls = extractCalls(caller.rawSteps);
    for (const cname of calls) {
      const cands = byName.get(cname);
      if (!cands || cands.length === 0) continue;
      for (const callee of cands) {
        if (!refs.has(callee.id)) refs.set(callee.id, []);
        refs.get(callee.id)!.push(caller.id);
      }
    }
  }
  // de-duplicate callers
  for (const [id, arr] of refs) {
    refs.set(id, Array.from(new Set(arr)));
  }
  return refs;
}

/** Writes JSON to .qa-cache/<name> */
async function writeCache(name: string, obj: any) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) throw new Error("No workspace open.");
  const dir = vscode.Uri.joinPath(ws, ".qa-cache");
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, name);
  const data = enc.encode(JSON.stringify(obj, null, 2));
  await vscode.workspace.fs.writeFile(file, data);
}

/** Main: parse, link, filter to referenced (base), write index */
export async function buildAndSaveBaseArtifacts(): Promise<{
  baseIndex: BaseScenariosIndex;
  nonBase: ScenarioDef[];
}> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) throw new Error("No workspace folder open.");

  // 1) Find .feature files (excludes target/, dist/, etc.)
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

  // 3) Populate references in a second pass
  const refs = populateReferences(allDefs);
  for (const d of allDefs) {
    d.referencedBy = refs.get(d.id) ?? [];
  }

  // 4) Filter to only referenced scenarios (strict base policy)
  const baseOnly = allDefs.filter((d) => (d.referencedBy?.length ?? 0) > 0);

  // 5) Group by name and de-duplicate definitions
  const byName = new Map<string, ScenarioDef[]>();
  for (const d of baseOnly) {
    const key = norm(d.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(d);
  }

  const baseScenarios: BaseScenariosIndex["baseScenarios"] = [];
  for (const [lowerName, defs] of byName) {
    const unique = dedupeScenarioDefs(defs);
    const displayName = unique[0]?.name ?? lowerName;
    baseScenarios.push({ name: displayName, definitions: unique });
  }

  // 6) Sort for stable output
  baseScenarios.sort((a, b) => a.name.localeCompare(b.name));

  // 7) Build index & write
  const baseIndex: BaseScenariosIndex = {
    version: "1.1",
    generatedAt: new Date().toISOString(),
    totalScenarios: allDefs.length,
    baseCount: baseOnly.length,
    nonBaseCount: allDefs.length - baseOnly.length,
    baseScenarios,
  };

  await writeCache("base-scenarios.index.json", baseIndex);

  // Optional diagnostics: who got excluded (top 100 by “base-looking” name)
  const nonBase = allDefs.filter((d) => (d.referencedBy?.length ?? 0) === 0);
  const diag = {
    totalCandidates: nonBase.length,
    note: "These scenarios are not referenced by any other scenario. They were excluded from base index.",
    samples: nonBase
      .slice(0, 100)
      .map(({ id, file, name, tags }) => ({ id, file, name, tags })),
  };
  await writeCache("candidates.base.json", diag);

  return { baseIndex, nonBase };
}
