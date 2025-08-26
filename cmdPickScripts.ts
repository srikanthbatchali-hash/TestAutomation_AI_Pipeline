// src/commands/cmdPickScripts.ts
import * as vscode from "vscode";
import { SessionStore } from "../state/sessionStore";
import { resolveTargetCandidates } from "../targets/resolveTarget";
import { rankBaseScenariosByTarget } from "../routes/rankByTarget";
import { captureApproval, captureRejection } from "../feedback/prompts";

export async function cmdPickScripts(opts: {
  appKey: string;
  loadBaseIndex: () => Promise<import("../base/mining").BaseScenariosIndex>;
  loadOrIndex: () => Promise<import("../pagegraph/types").OrIndex>;
  nav: import("../pagegraph/navRegistry").NavRegistry;
  loadProfile?: () => Promise<any | undefined>;
  loadPageCards?: () => Promise<any[] | undefined>;
}) {
  const keywords = SessionStore.get<string[]>("jiraKeywords") ?? [];
  const spec = SessionStore.get<any>("lastMileSpec") ?? {
    requiredVerbs: [],
    requiredControls: [],
    keywords,
  };

  const [baseIndex, orIndex, profile, pageCards] = await Promise.all([
    opts.loadBaseIndex(),
    opts.loadOrIndex(),
    opts.loadProfile?.() ?? Promise.resolve(undefined),
    opts.loadPageCards?.() ?? Promise.resolve(undefined),
  ]);

  // 1) Resolve target (if not set)
  let targetNode = SessionStore.get<string>("targetNode");
  if (!targetNode) {
    const cands = resolveTargetCandidates({
      appKey: opts.appKey,
      keywords,
      orIndex,
      nav: opts.nav,
      profile,
      pageCards,
    });
    if (!cands.length) {
      vscode.window.showWarningMessage(
        "No target page candidates found from keywords."
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      cands.slice(0, 10).map((c) => ({
        label: c.node,
        description: `conf=${c.confidence.toFixed(2)}`,
        detail: c.reasons.join(" | "),
        c,
      })),
      { placeHolder: "Select target page" }
    );
    if (!pick) return;
    targetNode = (pick as any).c.node;
    SessionStore.set("targetNode", targetNode);
  }

  // 2) Rank base scenarios vs target
  spec.targetNodes = [targetNode];
  const callGraph = buildPopularityMap(); // optional: from scenario-calls.index.json
  const ranked = rankBaseScenariosByTarget(
    baseIndex,
    opts.nav,
    orIndex,
    spec,
    callGraph
  );

  // 3) Show top results and capture feedback
  let approved: any[] = [];
  let offset = 0;
  const pageSize = 5;
  while (approved.length < 5) {
    const page = ranked.slice(offset, offset + pageSize);
    if (!page.length) break;
    const qp = page.map((r) => ({
      label: r.name,
      description: `score=${r.score.toFixed(2)} • ${r.caseLabel} • dist=${
        r.distance
      }`,
      detail: `${r.file} | ${r.reasons.join(" | ")}`,
      r,
    }));
    qp.push({ label: "Show more..." } as any);

    const pick = await vscode.window.showQuickPick(qp as any, {
      placeHolder: "Approve a route (up to 5)",
    });
    if (!pick) break;
    if ((pick as any).label === "Show more...") {
      offset += pageSize;
      continue;
    }

    const chosen = (pick as any).r;
    const action = await vscode.window.showQuickPick([
      "Approve",
      "Reject",
      "Skip",
    ]);
    if (action === "Approve") {
      approved.push(chosen);
      await captureApproval("routes", chosen.id, chosen.name, {
        targetNode,
        reasons: chosen.reasons,
      });
    } else if (action === "Reject") {
      await captureRejection("routes", chosen.id, chosen.name, {
        targetNode,
        reasons: chosen.reasons,
      });
    }
  }

  SessionStore.set("approvedRoutes", approved);
  vscode.window.showInformationMessage(
    `Approved ${approved.length} route(s) for target: ${targetNode}`
  );
}

function buildPopularityMap(): Map<string, number> {
  // Optional: load .qa-cache/scenario-calls.index.json and count inbound edges per callee id
  // If you don’t have it yet, return empty map.
  return new Map<string, number>();
}
