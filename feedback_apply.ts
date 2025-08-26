import { readAllEvents, indexStats } from "./store";
import type { FeedbackStats } from "./types";

/** Load feedback boosts/blacklist for route candidates (scenario ids). */
export async function loadRouteFeedbackMap(
  ids: string[]
): Promise<Map<string, FeedbackStats>> {
  const events = await readAllEvents();
  return indexStats(events, "route", ids);
}

/** Adjust a score with feedback; clamp & blacklist handling. */
export function applyFeedbackToScore(
  baseScore: number,
  stats?: FeedbackStats,
  wBoost = 0.15 // max extra weight contributed by feedback boost
): { score: number; banned: boolean; reason?: string } {
  if (!stats) return { score: baseScore, banned: false };
  if (stats.blacklist)
    return {
      score: 0,
      banned: true,
      reason: "blacklisted by recent rejections",
    };
  const delta = wBoost * stats.boost; // 0..0.15 typical
  const score = Math.max(0, Math.min(1, baseScore + delta));
  return { score, banned: false };
}
