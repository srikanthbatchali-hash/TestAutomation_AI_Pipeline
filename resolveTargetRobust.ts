// src/targets/resolveTargetRobust.ts
import * as vscode from "vscode";
import { buildPageLexicon, PageLexicon } from "./pageLexicon";
import { buildGraphShim } from "../pagegraph/graphShim";
import { navRegistry } from "../pagegraph/navRegistry";

type Profile = {
  aliases?: { pages?: Record<string, string[]> };
  domainMap?: Record<string, { targets?: string[] }>;
  weights?: Partial<{
    alias: number;
    domain: number;
    lex: number;
    popularity: number;
    reach: number;
  }>;
};

export type TargetCandidate = {
  node: string;
  confidence: number;
  reasons: string[];
  aliases?: string[];
};

const DEF_W = {
  alias: 0.3,
  domain: 0.2,
  lex: 0.3,
  popularity: 0.1,
  reach: 0.1,
};

function tok(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function simLex(text: string, lex: PageLexicon): number {
  // cosine over tf weights with binary query
  const q = new Set(tok(text));
  if (q.size === 0) return 0;
  let dot = 0,
    qnorm = Math.sqrt(q.size),
    l2 = 0;
  for (const v of lex.tokens.values()) l2 += v * v;
  l2 = Math.sqrt(l2) || 1;
  for (const term of q) {
    const w = lex.tokens.get(term) ?? 0;
    dot += w;
  }
  return dot / (qnorm * l2);
}

export async function resolveTargetRobust(
  ws: vscode.Uri,
  opts: {
    jiraText?: string; // full summary+AC (sanitized)
    keywords?: string[]; // if present, still useful
    profile?: Profile; // optional YAML
    pageCards?: Array<{ id: string; aliases?: string[]; inbound?: number }>; // optional
  }
): Promise<TargetCandidate[]> {
  const { lex } = await buildPageLexicon(ws);
  const graph = await buildGraphShim(navRegistry);
  const w = { ...DEF_W, ...(opts.profile?.weights ?? {}) };

  const text = (opts.jiraText ?? "").toLowerCase();
  const kws = new Set((opts.keywords ?? []).map((s) => s.toLowerCase()));

  const aliasMap = opts.profile?.aliases?.pages ?? {};
  const domainMap = opts.profile?.domainMap ?? {};

  // Precompute domain hits
  const domainHits = new Map<string, number>();
  for (const [term, m] of Object.entries(domainMap)) {
    if (!kws.has(term.toLowerCase())) continue;
    for (const t of m.targets ?? []) {
      domainHits.set(t, (domainHits.get(t) ?? 0) + 1);
    }
  }

  // Candidates: everyone, but we’ll rank and take top
  const cands: TargetCandidate[] = [];
  for (const l of lex) {
    // alias hits
    const aliases = [...(aliasMap[l.pageId] ?? []), ...(l.aliases ?? [])];
    const aliasHits = aliases.filter((a) => kws.has(a.toLowerCase())).length;

    // domain map
    const domain = domainHits.get(l.pageId) ?? 0;

    // lex similarity (strong when keywords are vague)
    const lexScore = simLex(text, l);

    // popularity via inbound (squashed)
    const pop = l.inbound ? 1 - 1 / (1 + l.inbound) : 0;

    // reach: prefer pages within a few hops of common landings (if you track them),
    // here we keep neutral unless you set a target; leave as 0.
    const reach = 0;

    const score =
      w.alias * squash(aliasHits) +
      w.domain * squash(domain) +
      w.lex * lexScore +
      w.popularity * pop +
      w.reach * reach;

    const reasons = [];
    if (aliasHits) reasons.push(`alias matches: ${aliasHits}`);
    if (domain) reasons.push(`domain hits: ${domain}`);
    if (lexScore > 0.05) reasons.push(`lexSim=${lexScore.toFixed(2)}`);
    if (l.inbound) reasons.push(`inbound=${l.inbound}`);

    cands.push({
      node: l.pageId,
      confidence: Math.max(0.2, Math.min(1, score)),
      reasons: reasons.length ? reasons : ["fallback: lexicon/popularity"],
      aliases: aliases.slice(0, 6),
    });
  }

  cands.sort((a, b) => b.confidence - a.confidence);
  return cands.slice(0, 20);
}

function squash(v: number) {
  return v > 0 ? 1 - 1 / (1 + v) : 0;
}
