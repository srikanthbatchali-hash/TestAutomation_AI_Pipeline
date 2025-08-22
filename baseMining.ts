import * as vscode from "vscode";
import { TextDecoder, TextEncoder } from "util";
import * as path from "path";
import { createHash } from "crypto";
import {
  LiteScenario, LiteStep,
  BaseScenariosIndex, ScenarioDef, ScenarioCallsIndex, ScenarioCall,
  BaseStepsCatalog, BaseStepPattern, ArgSlotStats
} from "./types";

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();

/* ===============================
   Public entrypoints
   =============================== */

/**
 * Build and save:
 *  - scenario-calls.index.json
 *  - base-scenarios.index.json
 *  - base-steps.catalog.json
 *
 * Order-independent (forward refs resolved after scan).
 */
export async function buildAndSaveBaseArtifacts(opts?: {
  glob?: string; outDir?: string; previewTemplateLimit?: number;
  samplePerPattern?: number; minPatternCount?: number;
}) {
  const glob = opts?.glob ?? "**/*.feature";
  const outDir = opts?.outDir ?? ".qa-cache";
  const previewLimit = Math.max(1, opts?.previewTemplateLimit ?? 3);
  const samplePerPattern = Math.max(1, opts?.samplePerPattern ?? 6);
  const minPatternCount = Math.max(1, opts?.minPatternCount ?? 1);

  // 1) Scan all feature files → lightweight scenarios
  const liteScenarios = await scanWorkspaceLite(glob);

  // 2) Ledgers (order-independent)
  const { defsByName, callsByName } = buildLedgers(liteScenarios, previewLimit);

  // 3) Resolve callers → candidate definitions
  const callsIndex = resolveScenarioCalls(defsByName, callsByName);

  // 4) Build Base Scenarios Registry
  const baseScenariosIndex = buildBaseScenariosIndex(defsByName, callsIndex);

  // 5) Build Base Steps Catalog (repo-wide canonical templates)
  const baseStepsCatalog = buildBaseStepsCatalog(liteScenarios, {
    samplePerPattern,
    minPatternCount
  });

  // 6) Save artifacts
  await saveJson(outDir, "scenario-calls.index.json", callsIndex);
  await saveJson(outDir, "base-scenarios.index.json", baseScenariosIndex);
  await saveJson(outDir, "base-steps.catalog.json", baseStepsCatalog);
}

/* ===============================
   Scanning (lite)
   =============================== */

async function scanWorkspaceLite(glob: string): Promise<LiteScenario[]> {
  const files = await vscode.workspace.findFiles(glob, "**/node_modules/**", 50000);
  const out: LiteScenario[] = [];

  for (const f of files) {
    const rel = vscode.workspace.asRelativePath(f);
    const txt = dec.decode(await vscode.workspace.fs.readFile(f));
    out.push(...parseFeatureLite(txt, rel));
  }
  return out;
}

function parseFeatureLite(text: string, relPath: string): LiteScenario[] {
  const lines = text.split(/\r?\n/);
  const scenarios: LiteScenario[] = [];

  let tags: string[] = [];
  let current: LiteScenario | null = null;

  const flush = () => {
    if (current) scenarios.push(current);
    current = null;
    tags = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const n = i + 1;

    if (/^\s*#/.test(line)) continue;
    if (/^\s*@/.test(line)) { tags = line.split(/\s+/).filter(t => t.startsWith("@")); continue; }

    const scen = line.match(/^\s*(Scenario Outline|Scenario)\s*:\s*(.+)$/i);
    if (scen) {
      flush();
      const type = scen[1].toLowerCase().includes("outline") ? "Scenario Outline" : "Scenario";
      current = {
        id: `${relPath}:${n}`,
        file: relPath,
        line: n,
        name: scen[2].trim(),
        type,
        tags: tags.slice(),
        steps: []
      };
      continue;
    }

    if (current) {
      const step = line.match(/^\s*(Given|When|Then|And|But)\s+(.*)$/i);
      if (step) {
        current.steps.push({
          keyword: step[1] as LiteStep["keyword"],
          text: step[2].trim(),
          line: n
        });
        continue;
      }
      // ignore Examples/docstrings/tables in lite scan
    }
  }
  flush();
  return scenarios;
}

/* ===============================
   Ledgers & Resolution
   =============================== */

type DefsLedger = Map<string /* lowerName */, ScenarioDef[]>;
type CallsLedger = Map<string /* lowerName */, ScenarioCall[]>;

function buildLedgers(all: LiteScenario[], previewLimit: number) {
  const defsByName: DefsLedger = new Map();
  const callsByName: CallsLedger = new Map();

  for (const s of all) {
    // DEF ledger (scenario definition)
    const lowerName = s.name.trim().toLowerCase();
    const preview = s.steps.slice(0, previewLimit).map(st => normalizeTemplateGeneric(`${st.keyword} ${st.text}`));
    const def: ScenarioDef = {
      id: s.id,
      file: s.file,
      type: s.type,
      tags: s.tags,
      previewTemplates: preview,
      examplesHeader: [],        // optional: fill if you later parse headers
      referencedBy: []
    };
    const arr = defsByName.get(lowerName) ?? [];
    arr.push(def);
    defsByName.set(lowerName, arr);

    // CALLS ledger (composite invocations)
    for (const st of s.steps) {
      const callee = detectCompositeCall(`${st.keyword} ${st.text}`);
      if (callee) {
        const call: ScenarioCall = {
          caller: { name: s.name, id: s.id, file: s.file },
          calleeName: callee,
          stepLine: st.line,
          candidates: [],
          evidence: `${s.file}:${st.line}`
        };
        const bucket = callsByName.get(callee.toLowerCase()) ?? [];
        bucket.push(call);
        callsByName.set(callee.toLowerCase(), bucket);
      }
    }
  }

  return { defsByName, callsByName };
}

function resolveScenarioCalls(defsByName: DefsLedger, callsByName: CallsLedger): ScenarioCallsIndex {
  const callsOut: ScenarioCall[] = [];

  for (const [calleeLower, calls] of callsByName.entries()) {
    const defs = defsByName.get(calleeLower) ?? [];
    for (const call of calls) {
      call.candidates = defs.map(d => ({ name: call.calleeName, id: d.id, file: d.file }));
      callsOut.push(call);
    }
  }

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    calls: callsOut
  };
}

function buildBaseScenariosIndex(defsByName: DefsLedger, callsIdx: ScenarioCallsIndex): BaseScenariosIndex {
  // backfill referencedBy
  const refsById = new Map<string /* def.id */, Set<string /* caller id */>>();
  for (const c of callsIdx.calls) {
    for (const cand of c.candidates) {
      const set = refsById.get(cand.id) ?? new Set<string>();
      set.add(c.caller.id);
      refsById.set(cand.id, set);
    }
  }

  // attach refs, group by callee name
  const baseScenarios: BaseScenariosIndex["baseScenarios"] = [];
  const ambiguous: BaseScenariosIndex["ambiguous"] = [];

  for (const [lowerName, defs] of defsByName.entries()) {
    const name = defs[0]?.id ? defs[0].id.split(":")[0] && (defs[0] as any).name || undefined : undefined; // not stored; keep lowerName only
    const enriched: ScenarioDef[] = defs.map(d => ({
      ...d,
      referencedBy: Array.from(refsById.get(d.id) ?? [])
    }));

    baseScenarios.push({
      name: defs.length ? /* use the original case from first def if needed */ (extractNameCase(defs, lowerName) ?? lowerName),
      definitions: enriched
    });

    if (defs.length > 1) {
      ambiguous.push({
        calleeName: extractNameCase(defs, lowerName) ?? lowerName,
        definitions: defs.map(d => d.id)
      });
    }
  }

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    baseScenarios,
    ambiguous
  };
}

function extractNameCase(defs: ScenarioDef[], lowerName: string): string | null {
  // try to recover original case from preview evidence (we don't keep the name string; safe fallback)
  // If you keep scenario name string in ScenarioDef later, replace this with that field.
  return null; // keep lowerName by default
}

/* ===============================
   Base Steps Catalog (patterns)
   =============================== */

function buildBaseStepsCatalog(all: LiteScenario[], opts: { samplePerPattern: number; minPatternCount: number }): BaseStepsCatalog {
  const buckets = new Map<string /* signature */, BaseStepPattern>();

  for (const s of all) {
    for (const st of s.steps) {
      const templ = normalizeTemplateToArgs(`${st.keyword} ${st.text}`);
      const sig = sha1(templ.toLowerCase());

      let pat = buckets.get(sig);
      if (!pat) {
        pat = {
          signature: sig,
          template: templ,
          count: 0,
          argSchema: buildEmptyArgSchema(templ),
          provenance: [],
          lastSeen: new Date().toISOString()
        };
        buckets.set(sig, pat);
      }
      pat.count++;
      if (pat.provenance.length < opts.samplePerPattern) {
        pat.provenance.push(s.id);
      }
      pat.lastSeen = new Date().toISOString();

      // Update arg stats from this step's quoted values
      updateArgStatsFromStep(pat.argSchema, `${st.keyword} ${st.text}`);
      // Optional: simple tags by verb
      if (!pat.tags) pat.tags = [];
      const verb = (templ.match(/^\s*(Given|When|Then|And|But)\s+(\w+)/i)?.[2] || "").toLowerCase();
      if (verb && !pat.tags.includes(verb)) pat.tags.push(verb);
    }
  }

  // prune rare patterns if desired
  const patterns: BaseStepPattern[] = Array.from(buckets.values()).filter(p => p.count >= opts.minPatternCount);

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    patterns
  };
}

function buildEmptyArgSchema(template: string): ArgSlotStats[] {
  const slots = Array.from(template.matchAll(/\{arg(\d+)\}/g)).map(m => `arg${m[1]}`);
  return slots.map(s => ({ slot: s, examples: [] }));
}

function updateArgStatsFromStep(schema: ArgSlotStats[], rawStep: string) {
  // extract quoted segments in order; map them to arg1, arg2, ...
  const quoted = Array.from(rawStep.matchAll(/"([^"]*)"/g)).map(m => m[1]);
  schema.forEach((slot, idx) => {
    const val = quoted[idx];
    if (typeof val !== "string") return;

    // examples (dedup, cap)
    if (!slot.examples.includes(val)) {
      if (slot.examples.length < 10) slot.examples.push(val);
      else {
        // simple reservoir: replace occasionally
        if (Math.random() < 0.1) slot.examples[Math.floor(Math.random() * slot.examples.length)] = val;
      }
    }

    // length stats
    const len = val.length;
    if (!slot.len) slot.len = { min: len, max: len };
    else {
      slot.len.min = Math.min(slot.len.min, len);
      slot.len.max = Math.max(slot.len.max, len);
    }

    // simple type guesses
    const guesses = new Set(slot.typeGuess ?? []);
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) guesses.add("date");
    if (/^(true|false|yes|no)$/i.test(val)) guesses.add("boolean");
    if (/^\d+$/.test(val)) guesses.add("int");
    // leave controlKey/pageKey inference to OR/page-graph join later
    slot.typeGuess = Array.from(guesses);

    // regex candidates (very light)
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      slot.regex = Array.from(new Set([...(slot.regex ?? []), "^\\d{4}-\\d{2}-\\d{2}$"]));
    }
  });
}

/* ===============================
   Composite call detection
   =============================== */

let COMPOSITE_CALL_RES: RegExp[] | null = null;

async function loadCompositeRegexes(): Promise<RegExp[]> {
  if (COMPOSITE_CALL_RES) return COMPOSITE_CALL_RES;
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) throw new Error("No workspace");
    const uri = vscode.Uri.joinPath(ws, ".qa-config", "composite-calls.regex.json");
    const buf = await vscode.workspace.fs.readFile(uri);
    const arr = JSON.parse(dec.decode(buf)) as string[];
    COMPOSITE_CALL_RES = arr.map(s => new RegExp(s, "i"));
  } catch {
    // fallback defaults
    COMPOSITE_CALL_RES = [
      /^\s*(Given|When|Then|And|But)\s+user\s+performs\s+"([^"]+)"\s*$/i,
      /^\s*(Given|When|Then|And|But)\s+user\s+(executes|runs|invokes)\s+"([^"]+)"\s*$/i
    ];
  }
  return COMPOSITE_CALL_RES!;
}

function detectCompositeCall(stepLine: string): string | null {
  // Synchronous check with cached defaults (config lazy-loaded above if needed elsewhere)
  const regs = COMPOSITE_CALL_RES ?? [
    /^\s*(Given|When|Then|And|But)\s+user\s+performs\s+"([^"]+)"\s*$/i,
    /^\s*(Given|When|Then|And|But)\s+user\s+(executes|runs|invokes)\s+"([^"]+)"\s*$/i
  ];
  for (const re of regs) {
    const m = stepLine.match(re);
    if (m) return (m[2] ?? m[3])?.trim() ?? null;
  }
  return null;
}

/* ===============================
   Normalization (generic)
   =============================== */

function normalizeTemplateGeneric(stepLine: string): string {
  // Replace every quoted segment with ordered {argN}; leave <angle> placeholders intact.
  let i = 1;
  return stepLine
    .replace(/"([^"]*)"/g, () => `"${'{' + 'arg' + (i++) + '}'}"`)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTemplateToArgs(stepLine: string): string {
  // same as generic (kept for clarity/extension)
  return normalizeTemplateGeneric(stepLine);
}

/* ===============================
   I/O helpers
   =============================== */

async function saveJson(outDir: string, fileName: string, obj: any) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error("No workspace open");
  const dir = vscode.Uri.joinPath(root, outDir);
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, fileName);
  await vscode.workspace.fs.writeFile(uri, enc.encode(JSON.stringify(obj, null, 2)));
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}
