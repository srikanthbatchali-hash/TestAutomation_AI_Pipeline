import * as vscode from "vscode";
import { appendEvent } from "./store";
import type { FeedbackEvent, EntityKind, Verdict } from "./types";

const DEFAULT_TAGS: Record<EntityKind, string[]> = {
  route: [
    "correct-path",
    "wrong-page",
    "too-long",
    "flaky",
    "role-mismatch",
    "uses-wrong-controls",
  ],
  target: ["right-target", "wrong-target", "ambiguous"],
  delta: ["good-delta", "bad-binding", "missing-step", "order-wrong"],
  validation: ["useful", "too-brittle", "needs-negative", "wrong-message"],
  plan: ["approve-plan", "reject-plan", "needs-data", "env-mismatch"],
};

async function capture(
  entityKind: EntityKind,
  entityId: string,
  entityName: string,
  verdict: Verdict,
  extra?: Partial<FeedbackEvent>
) {
  const tagOptions = DEFAULT_TAGS[entityKind] ?? [];
  const pickTags = await vscode.window.showQuickPick(
    tagOptions.map((t) => ({ label: t })),
    { canPickMany: true, placeHolder: "Select reasons (optional)" }
  );
  const note = await vscode.window.showInputBox({
    prompt: "Add an optional note",
    value: "",
  });

  const ev: FeedbackEvent = {
    ts: new Date().toISOString(),
    user: process.env["USER"] || process.env["USERNAME"],
    entityKind,
    entityId,
    entityName,
    verdict,
    tags: (pickTags ?? []).map((p) => p.label),
    note: note || undefined,
    ...extra,
  };
  await appendEvent(ev);
  vscode.window.showInformationMessage(
    `Recorded ${verdict} for ${entityKind}: ${entityName}`
  );
}

export async function captureApproval(
  entityKind: EntityKind,
  entityId: string,
  entityName: string,
  extra?: Partial<FeedbackEvent>
) {
  await capture(entityKind, entityId, entityName, "approve", extra);
}

export async function captureRejection(
  entityKind: EntityKind,
  entityId: string,
  entityName: string,
  extra?: Partial<FeedbackEvent>
) {
  await capture(entityKind, entityId, entityName, "reject", extra);
}

export async function captureNote(
  entityKind: EntityKind,
  entityId: string,
  entityName: string,
  extra?: Partial<FeedbackEvent>
) {
  await capture(entityKind, entityId, entityName, "note", extra);
}
