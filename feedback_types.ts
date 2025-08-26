export type Verdict = "approve" | "reject" | "note";
export type EntityKind =
  | "route" // base scenario candidate (id = scenarioDef.id)
  | "target" // chosen target node
  | "delta" // proposed last-mile delta step
  | "validation" // oracle template
  | "plan"; // last-mile plan id

export type FeedbackEvent = {
  ts: string; // ISO
  user?: string; // optional (from VS Code)
  jiraKey?: string;
  appKey?: string;
  entityKind: EntityKind;
  entityId: string; // stable id (e.g., scenario id, node id)
  entityName?: string; // display name
  verdict: Verdict;
  tags?: string[]; // reason codes
  note?: string; // freeform text
  ctx?: Record<string, any>; // extra (targetNode, reasons, etc.)
};

export type FeedbackStats = {
  entityKind: EntityKind;
  entityId: string;
  approvals: number;
  rejections: number;
  notes: number;
  lastTs?: string;
  tagsTop?: Array<{ tag: string; count: number }>;
  score: number; // approvals - rejections (bounded)
  blacklist: boolean; // true if rejected often recently
  boost: number; // 0..1 to add into ranking
};
