// src/states/stateTypes.ts
export type EvidenceCheck =
  | { kind: "text"; value: string }
  | { kind: "selector"; value: string }
  | { kind: "url"; value: string };

export type StateVariant = {
  id: string; // e.g. "v1"
  evidence: {
    textHints?: string[];
    attrs?: string[]; // data-test=..., role=...
    urlHints?: string[];
    roles?: Array<{ role: string; name?: string }>;
  };
};

export type StateCard = {
  id: string; // "Namespace.StateName"
  appKeys?: string[];
  capabilities?: string[];
  facets?: {
    roles?: string[];
    entities?: string[];
    platform?: "web" | "pega" | "mobile" | string;
    flags?: string[];
  };
  aliases?: string[];
  variants: StateVariant[];
  domSignature?: {
    tokens?: string[]; // for TF-IDF / Jaccard
    attrs?: string[];
  };
  widgets?: string[];
  topControls?: string[];
  orBindings?: Record<
    string,
    { candidates: Array<{ css: string; stability: number }> }
  >;
  validators?: {
    require?: EvidenceCheck[];
    optional?: EvidenceCheck[];
  };
  telemetry?: {
    inbound?: number;
    firstSeen?: string;
    lastSeen?: string;
  };

  // optional: Pega hints if applicable
  pega?: {
    class?: string;
    harness?: string;
    section?: string;
    caseType?: string;
    stage?: string;
    step?: string;
    attrs?: string[];
  };
};

export type StateCandidate = StateCard & {
  source: {
    fromPages: string[]; // OR page ids that fed this
    fromScenarios: string[]; // scenario ids that touched it
  };
  score?: number;
};
