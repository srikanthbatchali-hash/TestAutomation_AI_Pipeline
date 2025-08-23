// src/miners/baseMining.ts
import * as vscode from "vscode";
import { TextDecoder, TextEncoder } from "util";
import { createHash } from "crypto";
import {
  // Lite types we build internally here
  BaseScenariosIndex,
  ScenarioDef,
  ScenarioCallsIndex,
  ScenarioCall,
  BaseStepsCatalog,
  BaseStepPattern,
  ArgSlotStats,
} from "./types";

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();

/* =======================================================================
   PUBLIC ENTRYPOINT
   ======================================================================= */

export async function buildAndSaveBaseArtifacts(opts?: {
  glob?: string;
  outDir?: string;
  previewTemplateLimit?: number; // kept for compatibility (not used now)
  samplePerPattern?: number; // examples/provenance per pattern (default 6)
  minPatternCount?: number; // prune rare patterns (< count)
}): Promise<{
  baseScenarios: BaseScenariosIndex;
  scenarioCalls: ScenarioCallsIndex;
  baseSteps: BaseStepsCatalog;
}> {
  const glob = opts?.glob ?? "**/*.feature";
  const outDir = opts?.outDir ?? ".qa-cache";
  const samplePerPattern = Math.max(1, opts?.samplePerPattern ?? 6);
  const minPatternCount = Math.max(1, opts?.minPatternCount ?? 1);

  // 1) Lite scan of all feature files
  const lite = await scanWorkspaceLite(glob);

  // 2) Build ledgers (order-independent defs & calls)
  const { defsByName, callsByName } = buildLedgers(lite);

  // 3) Resolve callers → candidates
  const scenarioCalls = resolveScenarioCalls(defsByName, callsByName);

  // 4) Build Base Scenarios Registry (with raw steps + expansions)
  const baseScenarios = buildBaseScenariosIndex(defsByName, scenarioCalls);

  // 5) Build Base Steps Catalog (canonical templates + arg stats)
  const baseSteps = buildBaseStepsCatalog(lite, {
    samplePerPattern,
    minPatternCount,
  });

  // 6) Save artifacts
  await saveJson(outDir, "scenario-calls.index.json", scenarioCalls);
  await saveJson(outDir, "base-scenarios.index.json", baseScenarios);
  await saveJson(outDir, "base-steps.catalog.json", baseSteps);

  return { baseScenarios, scenarioCalls, baseSteps };
}

/* =======================================================================
   LITE PARSER
   ======================================================================= */

type LiteStep = {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string;
  line: number;
};
type LiteScenarioEx = {
  id: string;
  file: string;
  line: number;
  name: string;
  type: "Scenario" | "Scenario Outline";
  tags: string[];
  steps: LiteStep[];
  examplesHeader: string[];
  examplesRows: Record<string, string>[]; // small sample
};

async function scanWorkspaceLite(glob: string): Promise<LiteScenarioEx[]> {
  const files = await vscode.workspace.findFiles(
    glob,
    "**/node_modules/**",
    50000
  );
  const out: LiteScenarioEx[] = [];
  for (const f of files) {
    const rel = vscode.workspace.asRelativePath(f);
    const txt = dec.decode(await vscode.workspace.fs.readFile(f));
    out.push(...parseFeatureLite(txt, rel));
  }
  return out;
}

function parseFeatureLite(text: string, relPath: string): LiteScenarioEx[] {
  const lines = text.split(/\r?\n/);
  const scenarios: LiteScenarioEx[] = [];

  let tags: string[] = [];
  let current: LiteScenarioEx | null = null;

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
    if (/^\s*@/.test(line)) {
      tags = line.split(/\s+/).filter((t) => t.startsWith("@"));
      continue;
    }

    const scen = line.match(/^\s*(Scenario Outline|Scenario)\s*:\s*(.+)$/i);
    if (scen) {
      flush();
      const type: LiteScenarioEx["type"] = scen[1]
        .toLowerCase()
        .includes("outline")
        ? "Scenario Outline"
        : "Scenario";
      current = {
        id: `${relPath}:${n}`,
        file: relPath,
        line: n,
        name: scen[2].trim(),
        type,
        tags: tags.slice(),
        steps: [],
        examplesHeader: [],
        examplesRows: [],
      };
      continue;
    }

    if (!current) continue;

    const step = line.match(/^\s*(Given|When|Then|And|But)\s+(.*)$/i);
    if (step) {
      current.steps.push({
        keyword: step[1] as LiteStep["keyword"],
        text: step[2].trim(),
        line: n,
      });
      continue;
    }

    if (/^\s*Examples\s*:/i.test(line)) {
      let j = i + 1;
      if (j < lines.length && /^\s*@/.test(lines[j])) j++; // skip example-level tags
      const head = readRow(lines[j]);
      if (!head) {
        i = j;
        continue;
      }
      current.examplesHeader = head;
      j++;
      for (let k = 0; k < 5; k++) {
        // sample first 5 rows max
        const row = readRow(lines[j]);
        if (!row) break;
        const rec: Record<string, string> = {};
        head.forEach((h, idx) => (rec[h] = (row[idx] ?? "").trim()));
        current.examplesRows.push(rec);
        j++;
      }
      i = j - 1;
      continue;
    }
  }
  flush();
  return scenarios;
}

function readRow(line?: string): string[] | null {
  if (!line) return null;
  const m = line.match(/^\s*\|(.+)\|\s*$/);
  if (!m) return null;
  return m[1].split("|").map((c) => c.trim());
}

/* =======================================================================
   LEDGERS (ORDER-INDEPENDENT) & RESOLUTION
   ======================================================================= */

type DefsLedger = Map<string /* lowerName */, ScenarioDef[]>;
type CallsLedger = Map<string /* lowerName */, ScenarioCall[]>;

function buildLedgers(all: LiteScenarioEx[]) {
  const defsByName: DefsLedger = new Map();
  const callsByName: CallsLedger = new Map();

  for (const s of all) {
    const lowerName = s.name.trim().toLowerCase();

    // Expanded names from Examples (for display/search)
    const nameExpansions: string[] = [];
    if (
      s.type === "Scenario Outline" &&
      s.examplesHeader.length > 0 &&
      s.examplesRows.length > 0
    ) {
      for (let i = 0; i < Math.min(5, s.examplesRows.length); i++) {
        nameExpansions.push(bindAngles(s.name, s.examplesRows[i]));
      }
    }

    // Scenario definition with ORIGINAL steps (no normalization)
    const def: ScenarioDef = {
      id: s.id,
      file: s.file,
      type: s.type,
      tags: s.tags,
      rawSteps: s.steps.map((st) => ({
        keyword: st.keyword,
        text: st.text,
        line: st.line,
      })),
      examplesHeader: s.examplesHeader,
      examplesSample: s.examplesRows,
      nameExpansions,
      referencedBy: [],
    };

    const arr = defsByName.get(lowerName) ?? [];
    arr.push(def);
    defsByName.set(lowerName, arr);

    // Collect composite invocations from original lines
    for (const st of s.steps) {
      const callee = detectCompositeCall(`${st.keyword} ${st.text}`);
      if (callee) {
        const call: ScenarioCall = {
          caller: { name: s.name, id: s.id, file: s.file },
          calleeName: callee,
          stepLine: st.line,
          candidates: [],
          evidence: `${s.file}:${st.line}`,
        };
        const bucket = callsByName.get(callee.toLowerCase()) ?? [];
        bucket.push(call);
        callsByName.set(callee.toLowerCase(), bucket);
      }
    }
  }
  return { defsByName, callsByName };
}

function resolveScenarioCalls(
  defsByName: DefsLedger,
  callsByName: CallsLedger
): ScenarioCallsIndex {
  const callsOut: ScenarioCall[] = [];
  for (const [calleeLower, calls] of callsByName.entries()) {
    const defs = defsByName.get(calleeLower) ?? [];
    for (const call of calls) {
      call.candidates = defs.map((d) => ({
        name: call.calleeName,
        id: d.id,
        file: d.file,
      }));
      callsOut.push(call);
    }
  }
  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    calls: callsOut,
  };
}

function buildBaseScenariosIndex(
  defsByName: DefsLedger,
  callsIdx: ScenarioCallsIndex
): BaseScenariosIndex {
  // Aggregate reverse references
  const refsById = new Map<string, Set<string>>();
  for (const c of callsIdx.calls) {
    for (const cand of c.candidates) {
      const set = refsById.get(cand.id) ?? new Set<string>();
      set.add(c.caller.id);
      refsById.set(cand.id, set);
    }
  }

  const baseScenarios: BaseScenariosIndex["baseScenarios"] = [];
  const ambiguous: BaseScenariosIndex["ambiguous"] = [];

  for (const [lowerName, defs] of defsByName.entries()) {
    // Prefer a cleaned display name (first expansion) if available
    const displayName =
      defs.find((d) => (d.nameExpansions?.length ?? 0) > 0)
        ?.nameExpansions![0] ?? lowerName;

    const enriched = defs.map((d) => ({
      ...d,
      referencedBy: Array.from(refsById.get(d.id) ?? []),
    }));

    baseScenarios.push({ name: displayName, definitions: enriched });

    if (defs.length > 1) {
      ambiguous.push({
        calleeName: displayName,
        definitions: defs.map((d) => d.id),
      });
    }
  }

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    baseScenarios,
    ambiguous,
  };
}

function bindAngles(text: string, row: Record<string, string>): string {
  return text.replace(/<([^>]+)>/g, (_, k) => row[k] ?? `<${k}>`);
}

/* =======================================================================
   BASE STEPS CATALOG (CANONICAL)
   ======================================================================= */

function buildBaseStepsCatalog(
  all: LiteScenarioEx[],
  opts: { samplePerPattern: number; minPatternCount: number }
): BaseStepsCatalog {
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
          lastSeen: nowIso(),
        };
        buckets.set(sig, pat);
      }
      pat.count++;
      if (pat.provenance.length < opts.samplePerPattern) {
        pat.provenance.push(s.id);
      }
      pat.lastSeen = nowIso();

      // update arg stats from this raw step instance
      updateArgStatsFromStep(pat.argSchema, `${st.keyword} ${st.text}`);

      // light verb tag (optional)
      if (!pat.tags) pat.tags = [];
      const verb = (
        templ.match(/^\s*(Given|When|Then|And|But)\s+(\w+)/i)?.[2] || ""
      ).toLowerCase();
      if (verb && !pat.tags.includes(verb)) pat.tags.push(verb);
    }
  }

  // prune rare patterns if configured
  const patterns = Array.from(buckets.values()).filter(
    (p) => p.count >= opts.minPatternCount
  );

  return { version: "1.0", generatedAt: nowIso(), patterns };
}

function buildEmptyArgSchema(template: string): ArgSlotStats[] {
  const slots = Array.from(template.matchAll(/\{arg(\d+)\}/g)).map(
    (m) => `arg${m[1]}`
  );
  return slots.map((s) => ({ slot: s, examples: [] }));
}

function updateArgStatsFromStep(schema: ArgSlotStats[], rawStep: string) {
  const quoted = Array.from(rawStep.matchAll(/"([^"]*)"/g)).map((m) => m[1]);
  schema.forEach((slot, idx) => {
    const val = quoted[idx];
    if (typeof val !== "string") return;

    // examples (cap at 10; reservoir-ish replacement)
    if (!slot.examples.includes(val)) {
      if (slot.examples.length < 10) slot.examples.push(val);
      else if (Math.random() < 0.1)
        slot.examples[Math.floor(Math.random() * slot.examples.length)] = val;
    }

    // length stats
    const L = val.length;
    if (!slot.len) slot.len = { min: L, max: L };
    else {
      slot.len.min = Math.min(slot.len.min, L);
      slot.len.max = Math.max(slot.len.max, L);
    }

    // type guesses
    const g = new Set(slot.typeGuess ?? []);
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) g.add("date");
    if (/^(true|false|yes|no)$/i.test(val)) g.add("boolean");
    if (/^\d+$/.test(val)) g.add("int");
    slot.typeGuess = Array.from(g);

    // regex candidates
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      slot.regex = Array.from(
        new Set([...(slot.regex ?? []), "^\\d{4}-\\d{2}-\\d{2}$"])
      );
    }
  });
}

/* =======================================================================
   COMPOSITE CALL DETECTION
   ======================================================================= */

let COMPOSITE_CALL_RES: RegExp[] | null = null;

function detectCompositeCall(stepLine: string): string | null {
  const regs = COMPOSITE_CALL_RES ?? DEFAULT_CALLS;
  for (const re of regs) {
    const m = stepLine.match(re);
    if (m) return (m[2] ?? m[3])?.trim() ?? null;
  }
  return null;
}

// Optional: load from .qa-config/composite-calls.regex.json (call once at extension startup if desired)
export async function loadCompositeCallRegexesFromConfig() {
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) return;
    const uri = vscode.Uri.joinPath(
      ws,
      ".qa-config",
      "composite-calls.regex.json"
    );
    const buf = await vscode.workspace.fs.readFile(uri);
    const arr = JSON.parse(dec.decode(buf)) as string[];
    COMPOSITE_CALL_RES = arr.map((s) => new RegExp(s, "i"));
  } catch {
    COMPOSITE_CALL_RES = DEFAULT_CALLS;
  }
}

const DEFAULT_CALLS: RegExp[] = [
  /^\s*(Given|When|Then|And|But)\s+user\s+performs\s+"([^"]+)"\s*$/i,
  /^\s*(Given|When|Then|And|But)\s+user\s+(executes|runs|invokes)\s+"([^"]+)"\s*$/i,
];

/* =======================================================================
   NORMALIZATION FOR BASE-STEP TEMPLATES
   ======================================================================= */

function normalizeTemplateToArgs(stepLine: string): string {
  let i = 1;
  return stepLine
    .replace(/"([^"]*)"/g, () => `"${"{" + "arg" + i++ + "}"}"`)
    .replace(/\s+/g, " ")
    .trim();
}

/* =======================================================================
   IO HELPERS
   ======================================================================= */

async function saveJson(outDir: string, fileName: string, obj: any) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error("No workspace open");
  const dir = vscode.Uri.joinPath(root, outDir);
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, fileName);
  await vscode.workspace.fs.writeFile(
    uri,
    enc.encode(JSON.stringify(obj, null, 2))
  );
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}
