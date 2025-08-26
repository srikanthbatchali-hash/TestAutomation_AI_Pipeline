import * as vscode from "vscode";
import { TextEncoder, TextDecoder } from "util";
import { FeedbackEvent, FeedbackStats, EntityKind } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
const LOG_DIR = ".qa-cache/feedback";
const LOG_FILE = "events.jsonl";

async function ensureDir(): Promise<vscode.Uri> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) throw new Error("No workspace open.");
  const dir = vscode.Uri.joinPath(ws, LOG_DIR);
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

export async function appendEvent(ev: FeedbackEvent) {
  const dir = await ensureDir();
  const file = vscode.Uri.joinPath(dir, LOG_FILE);
  const line = JSON.stringify(ev) + "\n";
  try {
    const prev = await vscode.workspace.fs.readFile(file);
    const merged = new Uint8Array(prev.length + line.length);
    merged.set(prev, 0);
    merged.set(enc.encode(line), prev.length);
    await vscode.workspace.fs.writeFile(file, merged);
  } catch {
    await vscode.workspace.fs.writeFile(file, enc.encode(line));
  }
}

export async function readAllEvents(): Promise<FeedbackEvent[]> {
  const dir = await ensureDir();
  const file = vscode.Uri.joinPath(dir, LOG_FILE);
  try {
    const buf = await vscode.workspace.fs.readFile(file);
    const text = dec.decode(buf);
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Summarize events for a single entity. */
export function summarize(
  events: FeedbackEvent[],
  kind: EntityKind,
  id: string
): FeedbackStats {
  let approvals = 0,
    rejections = 0,
    notes = 0;
  const tagCounts = new Map<string, number>();
  let lastTs: string | undefined;

  for (const e of events) {
    if (e.entityKind !== kind || e.entityId !== id) continue;
    if (e.verdict === "approve") approvals++;
    else if (e.verdict === "reject") rejections++;
    else notes++;

    for (const t of e.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    if (!lastTs || e.ts > lastTs) lastTs = e.ts;
  }

  // bounded score (so one spam click doesn’t blow it up)
  const raw = approvals - rejections;
  const score = Math.max(-5, Math.min(5, raw));

  // simple blacklist rule: ≥2 rejections in last 14 days and no approvals in that window
  const now = Date.now();
  const windowMs = 14 * 24 * 3600 * 1000;
  let rejWin = 0,
    apprWin = 0;
  for (const e of events) {
    if (e.entityKind !== kind || e.entityId !== id) continue;
    if (now - Date.parse(e.ts) > windowMs) continue;
    if (e.verdict === "reject") rejWin++;
    if (e.verdict === "approve") apprWin++;
  }
  const blacklist = rejWin >= 2 && apprWin === 0;

  // convert score to a 0..1 boost (only positive adds boost)
  const boost = score > 0 ? Math.min(1, score / 5) : 0;

  const tagsTop = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  return {
    entityKind: kind,
    entityId: id,
    approvals,
    rejections,
    notes,
    lastTs,
    tagsTop,
    score,
    blacklist,
    boost,
  };
}

/** Precompute stats for many ids of a given kind. */
export function indexStats(
  events: FeedbackEvent[],
  kind: EntityKind,
  ids: string[]
): Map<string, FeedbackStats> {
  const out = new Map<string, FeedbackStats>();
  for (const id of ids) out.set(id, summarize(events, kind, id));
  return out;
}
