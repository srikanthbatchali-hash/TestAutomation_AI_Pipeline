// src/states/bootstrap.ts
import * as vscode from "vscode";
import { TextDecoder, TextEncoder } from "util";
import * as path from "path";
import { StateCandidate, StateCard } from "./stateTypes";

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();

type OrIndex = {
  pages: Record<
    string,
    { title?: string; displayName?: string; controls?: Record<string, any> }
  >;
};
type BaseIndex = {
  baseScenarios: Array<{
    name: string;
    definitions: Array<{
      id: string;
      name: string;
      file: string;
      rawSteps: Array<{ keyword: string; text: string }>;
    }>;
  }>;
};
type Edge = { from: string; to: string; label?: string };

const STOP = new Set([
  "the",
  "a",
  "to",
  "of",
  "and",
  "or",
  "for",
  "on",
  "in",
  "with",
  "by",
  "is",
  "are",
  "be",
  "page",
  "tab",
  "screen",
  "view",
  "form",
  "data",
  "info",
  "details",
  "list",
]);

function toks(s?: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t && t.length >= 2 && !STOP.has(t));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function jaccard(aSet: Set<string>, bSet: Set<string>) {
  const a = aSet.size,
    b = bSet.size;
  if (a === 0 && b === 0) return 1;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return inter / (a + b - inter);
}

async function readJson<T>(
  ws: vscode.Uri,
  rel: string,
  fallback: T
): Promise<T> {
  try {
    const buf = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(ws, rel)
    );
    return JSON.parse(dec.decode(buf));
  } catch {
    return fallback;
  }
}

async function writeJson(ws: vscode.Uri, rel: string, data: any) {
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(ws, path.dirname(rel))
  );
  const f = vscode.Uri.joinPath(ws, rel);
  await vscode.workspace.fs.writeFile(
    f,
    enc.encode(JSON.stringify(data, null, 2))
  );
}

export async function cmdStatesBootstrap() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) {
    vscode.window.showErrorMessage("Open a workspace.");
    return;
  }

  const or: OrIndex = await readJson(ws, ".qa-cache/or.index.json", {
    pages: {},
  });
  const base: BaseIndex = await readJson(
    ws,
    ".qa-cache/base-scenarios.index.json",
    { baseScenarios: [] }
  );
  const edges: Edge[] = await readJson(
    ws,
    ".qa-cache/nav-edges.learned.json",
    []
  );

  // inbound counts (popularity)
  const inbound = new Map<string, number>();
  for (const e of edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);

  // build control->page
  const ctrl2page = new Map<string, string>();
  for (const [pid, p] of Object.entries(or.pages)) {
    for (const key of Object.keys(p.controls ?? {})) {
      if (!ctrl2page.has(key)) ctrl2page.set(key, pid);
    }
  }

  // which scenarios touch which pages (via quoted control keys)
  const page2scenarios = new Map<string, Set<string>>();
  const scenarioNames = new Map<string, string>();
  for (const group of base.baseScenarios) {
    for (const d of group.definitions) {
      scenarioNames.set(d.id, d.name);
      const quoted = d.rawSteps.flatMap((s) =>
        (s.text.match(/"([^"]+)"/g) ?? []).map((q) => q.slice(1, -1))
      );
      const touched = new Set<string>();
      for (const q of quoted) {
        const p = ctrl2page.get(q);
        if (p) touched.add(p);
      }
      for (const p of touched) {
        if (!page2scenarios.has(p)) page2scenarios.set(p, new Set());
        page2scenarios.get(p)!.add(d.id);
      }
    }
  }

  // draft candidates per OR page
  const candidates: StateCandidate[] = [];
  const now = new Date().toISOString();

  for (const [pid, p] of Object.entries(or.pages)) {
    const alias = uniq([
      ...toks(pid),
      ...toks(p.title),
      ...toks(p.displayName),
    ]);

    const controls = Object.keys(p.controls ?? {});
    const controlTokens = uniq(controls.flatMap(toks));

    // scenario phrases that referenced controls on this page
    const sids = Array.from(page2scenarios.get(pid) ?? []);
    const sPhrases = uniq(
      sids.flatMap((id) => toks(scenarioNames.get(id) ?? ""))
    );

    const tokens = uniq([...alias, ...controlTokens, ...sPhrases]).slice(0, 60);
    const inboundCount = inbound.get(pid) ?? 0;

    const cand: StateCandidate = {
      id: pid,
      appKeys: [], // you can fill from app.properties later
      facets: { platform: "web" },
      aliases: alias.slice(0, 8),
      variants: [
        {
          id: "v1",
          evidence: {
            textHints: alias.filter((x) => x.length > 3).slice(0, 2),
            attrs: [], // fill later from runtime if you like
          },
        },
      ],
      domSignature: { tokens },
      widgets: [], // can infer later from OR containers if you track them
      topControls: controls.slice(0, 8),
      validators: {
        require: alias.length ? [{ kind: "text", value: alias[0] }] : [],
      },
      telemetry: { inbound: inboundCount, firstSeen: now, lastSeen: now },
      source: {
        fromPages: [pid],
        fromScenarios: sids.slice(0, 20),
      },
    };

    candidates.push(cand);
  }

  // dedup/merge into archetypes (prefer same id; otherwise by similarity)
  const merged: StateCandidate[] = [];
  const THRESH = 0.8;

  for (const c of candidates) {
    const cSet = new Set(c.domSignature?.tokens ?? []);
    let mergedInto: StateCandidate | null = null;

    for (const m of merged) {
      const mSet = new Set(m.domSignature?.tokens ?? []);
      const sim = jaccard(cSet, mSet);
      if (c.id === m.id || sim >= THRESH) {
        // merge as variant
        m.aliases = uniq([...(m.aliases ?? []), ...(c.aliases ?? [])]).slice(
          0,
          12
        );
        m.domSignature = {
          tokens: uniq([
            ...(m.domSignature?.tokens ?? []),
            ...(c.domSignature?.tokens ?? []),
          ]).slice(0, 120),
        };
        m.topControls = uniq([
          ...(m.topControls ?? []),
          ...(c.topControls ?? []),
        ]).slice(0, 12);
        m.variants = [
          ...(m.variants ?? []),
          ...c.variants.map((v, i) => ({
            ...v,
            id: v.id || `var${m.variants.length + i + 1}`,
          })),
        ].slice(0, 4);
        m.telemetry = {
          inbound: (m.telemetry?.inbound ?? 0) + (c.telemetry?.inbound ?? 0),
          firstSeen: m.telemetry?.firstSeen ?? c.telemetry?.firstSeen,
          lastSeen: now,
        };
        m.source.fromPages = uniq([
          ...(m.source.fromPages ?? []),
          ...(c.source.fromPages ?? []),
        ]);
        m.source.fromScenarios = uniq([
          ...(m.source.fromScenarios ?? []),
          ...(c.source.fromScenarios ?? []),
        ]).slice(0, 100);
        mergedInto = m;
        break;
      }
    }

    if (!mergedInto) merged.push(c);
  }

  await writeJson(ws, ".qa-cache/state-cards.candidates.json", merged);
  vscode.window.showInformationMessage(
    `State candidates bootstrapped: ${merged.length}`
  );
}
