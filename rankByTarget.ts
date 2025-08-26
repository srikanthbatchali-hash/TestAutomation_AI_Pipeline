// src/routes/rankByTarget.ts
import type { NavRegistry } from "../pagegraph/navRegistry";
import type { OrIndex } from "../pagegraph/types";
import type { BaseScenariosIndex, ScenarioDef } from "../base/mining";

export type RankWeights = {
  reach: number; // closer endNode→target gets more points
  bind: number; // how many required controls already used
  verbs: number; // overlap with required verbs
  ac: number; // keyword overlap with Jira AC (optional)
  freq: number; // how often this composite is called (popularity)
};

export type LastMileSpec = {
  targetNodes?: string[]; // chosen target(s)
  requiredControls?: string[]; // OR keys implied by AC
  requiredVerbs: string[]; // ["input","select","click","validate"]
  keywords?: string[]; // Jira tokens for ac overlap
};

export type RankedCandidate = {
  id: string;
  name: string;
  file: string;
  score: number;
  distance: number; // hops to target (Infinity if unknown)
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

export function rankBaseScenariosByTarget(
  baseIndex: BaseScenariosIndex,
  nav: NavRegistry,
  orIndex: OrIndex,
  spec: LastMileSpec,
  callGraph?: Map<string, number>, // scenario id -> how many callers (popularity)
  weights: Partial<RankWeights> = {}
): RankedCandidate[] {
  const w = { ...DEF_W, ...weights };
  const target = spec.targetNodes?.[0] ?? null;
  const reqCtrls = new Set(spec.requiredControls ?? []);
  const reqVerbs = new Set(
    (spec.requiredVerbs ?? []).map((v) => v.toLowerCase())
  );
  const acTokens = new Set((spec.keywords ?? []).map((k) => k.toLowerCase()));

  const out: RankedCandidate[] = [];

  for (const group of baseIndex.baseScenarios) {
    for (const d of group.definitions) {
      // 1) Infer endNode
      const endNode = inferEndNodeFromSteps(d, orIndex, nav);

      // 2) Reach
      let distance = Number.POSITIVE_INFINITY;
      let reachScore = 0;
      if (target && endNode) {
        distance = nav.distance(endNode, target);
        if (Number.isFinite(distance)) {
          // map small distances to higher scores
          reachScore = 1 / (1 + Math.max(0, distance));
        }
      }

      // 3) Bind coverage: how many required controls already appear
      const usedCtrls = controlsUsedInScenario(d, orIndex);
      const bindCov = reqCtrls.size
        ? [...reqCtrls].filter((c) => usedCtrls.has(c)).length / reqCtrls.size
        : 0;

      // 4) Verb coverage
      const verbsUsed = verbsUsedInScenario(d);
      const verbCov = reqVerbs.size
        ? [...reqVerbs].filter((v) => verbsUsed.has(v)).length / reqVerbs.size
        : 0;

      // 5) AC token overlap (with scenario name + step text)
      const acCov = acOverlap(d, acTokens);

      // 6) Popularity
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
          : target && Number.isFinite(distance)
          ? "extend"
          : "explore";

      const reasons = [
        target
          ? `distance=${Number.isFinite(distance) ? distance : "∞"}`
          : "no target",
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
        distance: Number.isFinite(distance) ? distance : 99,
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
  orIndex: OrIndex,
  nav: NavRegistry
): string | null {
  // Heuristic: take the page of the LAST control used in the scenario.
  const used = controlsUsedInScenario(d, orIndex, true /* keep order */);
  let last: string | undefined;
  for (const ctrl of used as any as string[]) last = ctrl;
  if (!last) return null;
  const page = orIndex.controls[last]?.page;
  return page ?? null;
}

function controlsUsedInScenario(
  d: ScenarioDef,
  orIndex: OrIndex,
  ordered = false
): Set<string> | string[] {
  const hits: string[] = [];
  for (const s of d.rawSteps) {
    const quoted = s.text.match(/"([^"]+)"/g) ?? [];
    for (const q of quoted) {
      const k = q.slice(1, -1);
      if (orIndex.controls[k]) hits.push(k);
    }
  }
  return ordered ? hits : new Set(hits);
}

function verbsUsedInScenario(d: ScenarioDef): Set<string> {
  const verbs = new Set<string>();
  for (const s of d.rawSteps) {
    const first = s.text.toLowerCase().split(/\s+/)[0];
    // normalize And/But by previous keyword if needed; for now just take the lexeme
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
