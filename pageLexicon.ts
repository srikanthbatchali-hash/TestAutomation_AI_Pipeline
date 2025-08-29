// src/targets/pageLexicon.ts
import * as vscode from "vscode";
import { TextDecoder } from "util";
const dec = new TextDecoder("utf-8");

type OrIndex = {
  pages: Record<
    string,
    { controls?: Record<string, any>; title?: string; displayName?: string }
  >;
};

type BaseIndex = {
  baseScenarios: Array<{
    name: string;
    definitions: Array<{
      id: string;
      file: string;
      name: string;
      rawSteps: Array<{ keyword: string; text: string }>;
    }>;
  }>;
};

type PageCard = { id: string; aliases?: string[]; inbound?: number };

export type PageLexicon = {
  pageId: string;
  tokens: Map<string, number>; // tf weights
  aliases: string[];
  inbound: number;
};

const SPLIT = /[^a-z0-9]+/i;
const stop = new Set([
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
]);

function tok(s: string): string[] {
  return s
    .toLowerCase()
    .split(SPLIT)
    .filter((t) => t && !stop.has(t) && t.length >= 2);
}

export async function buildPageLexicon(
  ws: vscode.Uri
): Promise<{ lex: PageLexicon[]; ctrl2page: Map<string, string> }> {
  const or = await readJson<OrIndex>(ws, ".qa-cache/or.index.json", {
    pages: {},
  });
  const base = await readJson<BaseIndex>(
    ws,
    ".qa-cache/base-scenarios.index.json",
    { baseScenarios: [] }
  );
  const cards = await readJson<PageCard[]>(ws, ".qa-cache/page-cards.json", []);

  const ctrl2page = new Map<string, string>();
  for (const [pageId, page] of Object.entries(or.pages ?? {})) {
    for (const key of Object.keys(page.controls ?? {})) {
      if (!ctrl2page.has(key)) ctrl2page.set(key, pageId);
    }
  }

  // Build usage bag per page from scenarios that mention its controls
  const usageBag = new Map<string, string[]>(); // pageId -> texts
  for (const group of base.baseScenarios) {
    for (const d of group.definitions) {
      // collect all quoted strings as potential control keys
      const quoted = d.rawSteps.flatMap((s) =>
        (s.text.match(/"([^"]+)"/g) ?? []).map((q) => q.slice(1, -1))
      );
      const pagesHit = new Set<string>();
      for (const key of quoted) {
        const p = ctrl2page.get(key);
        if (p) pagesHit.add(p);
      }
      if (pagesHit.size) {
        const bundle = [
          group.name,
          d.name,
          ...d.rawSteps.map((s) => s.text),
        ].join(" ");
        for (const p of pagesHit) {
          if (!usageBag.has(p)) usageBag.set(p, []);
          usageBag.get(p)!.push(bundle);
        }
      }
    }
  }

  // Assemble lexicon per page
  const pageCardsMap = new Map(cards.map((c) => [c.id, c]));
  const out: PageLexicon[] = [];

  for (const [pageId, page] of Object.entries(or.pages ?? {})) {
    const tokens = new Map<string, number>();

    // Titles / display names
    for (const s of [page.title, page.displayName].filter(
      Boolean
    ) as string[]) {
      for (const t of tok(s)) tokens.set(t, (tokens.get(t) ?? 0) + 3);
    }

    // PageId tokens (split by ./_ and camel)
    const idTokens = pageId.split(/[._/:-]+/).flatMap((x) => tok(x));
    for (const t of idTokens) tokens.set(t, (tokens.get(t) ?? 0) + 2);

    // Control keys
    for (const key of Object.keys(page.controls ?? {})) {
      for (const t of tok(key)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    }

    // Scenario usage text
    for (const blob of usageBag.get(pageId) ?? []) {
      for (const t of tok(blob)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    }

    // Aliases from page-cards
    const aliases = pageCardsMap.get(pageId)?.aliases ?? [];
    for (const a of aliases)
      for (const t of tok(a)) tokens.set(t, (tokens.get(t) ?? 0) + 2);

    // Simple tf normalization
    const sum = Array.from(tokens.values()).reduce((a, b) => a + b, 0) || 1;
    for (const [k, v] of Array.from(tokens.entries())) tokens.set(k, v / sum);

    out.push({
      pageId,
      tokens,
      aliases,
      inbound: pageCardsMap.get(pageId)?.inbound ?? 0,
    });
  }

  return { lex: out, ctrl2page };
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
