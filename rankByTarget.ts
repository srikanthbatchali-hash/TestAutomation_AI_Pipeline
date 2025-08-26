// src/routes/rankByTarget.ts
// Uses GraphShim instead of NavRegistry.distance, and supports OR where controls live under pages.
import type { BaseScenariosIndex, ScenarioDef } from "../base/mining";
import type { GraphShim } from "../pagegraph/graphShim";

export type OrIndex = {
  appKey?: string;
  pages: Record<
    string,
    {
      // page id -> meta
      controls?: Record<
        string,
        {
          /* any */
        }
      >; // controlKey -> meta
    }
  >;
};

export type RankWeights = {
  reach: number;
  bind: number;
  verbs: number;
  ac: number;
  freq: number;
};
export type LastMileSpec = {
  targetNodes?: string[];
  requiredControls?: string[];
  requiredVerbs: string[];
  keywords?: string[];
};

export type RankedCandidate = {
  id: string;
  name: string;
  file: string;
  score: number;
  distance: number;
  endNode?: string | null;
  reasons: string[];
  caseLabel: "reuse" | "extend" | "explore";
};

const DEF_W: RankWeights = {
  reach: 0.45,
  bind: 0.2,
  verbs: 0.15,
  ac: 0.1,
  freq: 0.1,
};

// Build a quick control->page index from page-scoped controls
function buildControlToPage(orIndex: OrIndex): Map<string, string> {
  const map = new Map<string, string>();
  for (const [pageId, page] of Object.entries(orIndex.pages || {})) {
    const ctrls = page.controls || {};
    for (const key of Object.keys(ctrls)) {
      if (!map.has(key)) map.set(key, pageId);
    }
  }
  return map;
}

export function rankBaseScenariosByTarget(
  baseIndex: BaseScenariosIndex,
  graph: GraphShim,
  orIndex: OrIndex,
  spec: LastMileSpec,
  callGraph?: Map<string, number>, // scenario id -> popularity
  weights: Partial<RankWeights> = {}
): RankedCandidate[] {
  const w = { ...DEF_W, ...weights };
  const target = spec.targetNodes?.[0] ?? null;
  const reqCtrls = new Set(spec.requiredControls ?? []);
  const reqVerbs = new Set(
    (spec.requiredVerbs ?? []).map((v) => v.toLowerCase())
  );
  const acTokens = new Set((spec.keywords ?? []).map((k) => k.toLowerCase()));
  const ctrl2page = buildControlToPage(orIndex);

  const out: RankedCandidate[] = [];

  for (const group of baseIndex.baseScenarios) {
    for (const d of group.definitions) {
      // End node: page of the LAST referenced control (by appearance order)
      const endNode = inferEndNodeFromSteps(d, ctrl2page);

      // Reach via shim
      let distance = 99,
        reachScore = 0;
      if (target && endNode) {
        distance = graph.distance(endNode, target);
        reachScore = distance < 99 ? 1 / (1 + distance) : 0;
      }

      // Bind coverage: how many required controls are already present
      const usedCtrls = controlsUsedInScenario(d, ctrl2page, true); // ordered list
      const usedSet = new Set(usedCtrls);
      const bindCov = reqCtrls.size
        ? [...reqCtrls].filter((c) => usedSet.has(c)).length / reqCtrls.size
        : 0;

      // Verb coverage: crude lexeme from each step
      const verbsUsed = verbsUsedInScenario(d);
      const verbCov = reqVerbs.size
        ? [...reqVerbs].filter((v) => verbsUsed.has(v)).length / reqVerbs.size
        : 0;

      // AC overlap: tokens found in name/steps
      const acCov = acOverlap(d, acTokens);

      // Popularity
      const freq = callGraph?.get(d.id) ?? 0;
      const freqScore = freq > 0 ? 1 - 1 / (1 + freq) : 0;

      const score =
        w.reach * reachScore +
        w.bind * bindCov +
        w.verbs * verbCov +
        w.ac * acCov +
        w.freq * freqScore;

      const caseLabel: RankedCandidate["caseLabel"] =
        target && endNode && distance === 0
          ? "reuse"
          : target && distance < 99
          ? "extend"
          : "explore";

      const reasons = [
        target ? `distance=${distance < 99 ? distance : "∞"}` : "no target",
        reqCtrls.size
          ? `bind=${(bindCov * 100).toFixed(0)}% of ${reqCtrls.size}`
          : "no required controls",
        reqVerbs.size
          ? `verbs=${(verbCov * 100).toFixed(0)}% of ${reqVerbs.size}`
          : "no verb req",
        acTokens.size
          ? `acOverlap=${(acCov * 100).toFixed(0)}%`
          : "no AC tokens",
        freq ? `popularity=${freq}` : "popularity=0",
      ];

      out.push({
        id: d.id,
        name: group.name,
        file: d.file,
        score,
        distance,
        endNode,
        reasons,
        caseLabel,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 50);
}

// --- helpers ---

function inferEndNodeFromSteps(
  d: ScenarioDef,
  ctrl2page: Map<string, string>
): string | null {
  const used = controlsUsedInScenario(d, ctrl2page, true);
  let last: string | undefined;
  for (const k of used) last = k;
  return last ? ctrl2page.get(last) ?? null : null;
}

function controlsUsedInScenario(
  d: ScenarioDef,
  ctrl2page: Map<string, string>,
  ordered = false
): string[] | Set<string> {
  const hits: string[] = [];
  for (const s of d.rawSteps) {
    const quoted = s.text.match(/"([^"]+)"/g) ?? [];
    for (const q of quoted) {
      const key = q.slice(1, -1);
      if (ctrl2page.has(key)) hits.push(key);
    }
  }
  return ordered ? hits : new Set(hits);
}

function verbsUsedInScenario(d: ScenarioDef): Set<string> {
  const verbs = new Set<string>();
  for (const s of d.rawSteps) {
    const first = s.text.toLowerCase().split(/\s+/)[0];
    verbs.add(first);
  }
  return verbs;
}

function acOverlap(d: ScenarioDef, acTokens: Set<string>): number {
  if (acTokens.size === 0) return 0;
  const bag = new Set<string>();
  bag.add(d.name.toLowerCase());
  for (const s of d.rawSteps) bag.add(s.text.toLowerCase());
  const joined = [...bag].join(" ");
  const hits = [...acTokens].filter((t) => joined.includes(t)).length;
  return hits / Math.max(1, acTokens.size);
}
