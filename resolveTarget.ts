// src/targets/resolveTarget.ts
import type { OrIndex } from "../pagegraph/types";
import type { NavRegistry } from "../pagegraph/navRegistry";
import { SessionStore } from "../state/sessionStore";

export type TargetCandidate = {
  node: string; // canonical page/section id
  confidence: number; // 0..1
  reasons: string[];
  aliases?: string[];
};

export type ResolveTargetOpts = {
  appKey: string;
  keywords: string[]; // from Jira summary/AC (already in SessionStore)
  orIndex: OrIndex;
  nav: NavRegistry;
  profile?: {
    aliases?: { pages?: Record<string, string[]> };
    domainMap?: Record<string, { targets?: string[] }>;
    weights?: Partial<{ alias: number; domain: number; connectivity: number }>;
  };
  pageCards?: Array<{ id: string; aliases?: string[]; inbound?: number }>; // optional learned cards
};

const defW = { alias: 0.45, domain: 0.35, connectivity: 0.2 };

export function resolveTargetCandidates(
  opts: ResolveTargetOpts
): TargetCandidate[] {
  const { keywords, orIndex, nav, profile, pageCards } = opts;
  const kw = new Set(keywords.map((k) => k.toLowerCase()));

  // 1) From profile.domainMap tokens → targets
  const domainHits = new Map<string, number>();
  if (profile?.domainMap) {
    for (const [term, m] of Object.entries(profile.domainMap)) {
      if (!kw.has(term.toLowerCase())) continue;
      for (const t of m.targets ?? []) {
        domainHits.set(t, (domainHits.get(t) ?? 0) + 1);
      }
    }
  }

  // 2) Alias matching (profile aliases + pageCards aliases)
  const aliasHits = new Map<string, number>();
  const aliasMap: Record<string, string[]> = {
    ...(profile?.aliases?.pages ?? {}),
  };
  for (const pc of pageCards ?? []) {
    if (pc.aliases?.length)
      aliasMap[pc.id] = Array.from(
        new Set([...(aliasMap[pc.id] ?? []), ...pc.aliases])
      );
  }
  for (const [node, aliases] of Object.entries(aliasMap)) {
    const hits = (aliases ?? []).filter((a) => kw.has(a.toLowerCase())).length;
    if (hits > 0) aliasHits.set(node, hits);
  }

  // 3) Connectivity (prefer nodes that are well-connected in NavRegistry / observed inbound)
  const conn = new Map<string, number>();
  for (const node of new Set([...aliasHits.keys(), ...domainHits.keys()])) {
    const inbound = pageCards?.find((p) => p.id === node)?.inbound ?? 0;
    // if you have a nav.degree() use that; fallback to observed inbound
    conn.set(node, inbound);
  }

  const w = { ...defW, ...(profile?.weights ?? {}) };
  const unionNodes = Array.from(
    new Set([...aliasHits.keys(), ...domainHits.keys()])
  );
  const out: TargetCandidate[] = unionNodes.map((node) => {
    const a = aliasHits.get(node) ?? 0;
    const d = domainHits.get(node) ?? 0;
    const c = conn.get(node) ?? 0;
    const score =
      normalize(a) * w.alias +
      normalize(d) * w.domain +
      normalize(c) * w.connectivity;
    return {
      node,
      confidence: Math.max(0.2, Math.min(1, score)),
      reasons: reasonLines(node, a, d, c, aliasMap[node]),
      aliases: aliasMap[node] ?? [],
    };
  });

  // Sort by confidence
  out.sort((x, y) => y.confidence - x.confidence);
  // Persist top pick into session for downstream commands
  if (out[0]) SessionStore.set("targetNode", out[0].node);
  SessionStore.set("targetCandidates", out);
  return out;
}

function normalize(v: number) {
  // quick squash to 0..1; tune if you want
  return v > 0 ? 1 - 1 / (1 + v) : 0;
}
function reasonLines(
  node: string,
  aliasHits: number,
  domainHits: number,
  conn: number,
  aliases?: string[]
) {
  const r: string[] = [];
  if (aliasHits)
    r.push(
      `alias matches: ${aliasHits}${
        aliases?.length ? ` (${aliases?.slice(0, 4).join(", ")})` : ""
      }`
    );
  if (domainHits) r.push(`domain term hits: ${domainHits}`);
  if (conn) r.push(`observed inbound: ${conn}`);
  return r.length ? r : [`fallback: inferred from keywords`];
}
