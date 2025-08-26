// src/pagegraph/graphShim.ts
export type EdgeResolved = { from: string; to: string; label?: string };

export type GraphShim = {
  /** # of hops; 99 if unreachable. */
  distance: (
    start: string | null | undefined,
    target: string | null | undefined
  ) => number;
  /** Returns the actual path if you need it later. */
  shortestPath: (
    start: string,
    target: string,
    maxDepth?: number
  ) => { distance: number; path: string[] };
  /** For convenience if you want to resolve friendly names to ids outside. */
  neighborsOf: (node: string) => string[];
};

/** Build a reusable shim from your existing navRegistry. */
export async function buildGraphShim(navRegistry: {
  loadEdges: () => Promise<EdgeResolved[]>;
}): Promise<GraphShim> {
  const edges = await navRegistry.loadEdges();
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
    // If your graph is effectively bidirectional for UI tabs/menus, uncomment:
    // if (!adj.has(e.to)) adj.set(e.to, []);
    // adj.get(e.to)!.push(e.from);
  }

  function shortestPath(start: string, target: string, maxDepth = 20) {
    if (start === target) return { distance: 0, path: [start] };
    const q: string[] = [start];
    const parent = new Map<string, string | null>();
    parent.set(start, null);
    let depth = 0;

    while (q.length && depth <= maxDepth) {
      const levelCount = q.length;
      for (let i = 0; i < levelCount; i++) {
        const node = q.shift()!;
        const nbrs = adj.get(node) ?? [];
        for (const nxt of nbrs) {
          if (parent.has(nxt)) continue;
          parent.set(nxt, node);
          if (nxt === target) {
            // reconstruct
            const path: string[] = [];
            let cur: string | null = nxt;
            while (cur) {
              path.push(cur);
              cur = parent.get(cur) ?? null;
            }
            path.reverse();
            return { distance: path.length - 1, path };
          }
          q.push(nxt);
        }
      }
      depth++;
    }
    return { distance: 99, path: [] };
  }

  return {
    neighborsOf: (node) => adj.get(node) ?? [],
    distance: (start, target) => {
      if (!start || !target) return 99;
      return shortestPath(start, target).distance;
    },
    shortestPath,
  };
}
