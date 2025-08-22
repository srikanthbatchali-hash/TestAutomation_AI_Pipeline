export type ParamRef = {
  // e.g. for "Then user inputs \"<child_name>\" in \"childName.input\""
  // angleParams: ["child_name"], curlyParams: ["username"]
  angle: string[];
  curly: string[];
};

export type DataTable = {
  header?: string[];
  rows: string[][];
  startLine: number;
  endLine: number;
};

export type DocString = {
  contentType?: string;
  value: string;
  startLine: number;
  endLine: number;
};

export type ParsedStep = {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string; // raw step line, without table/docstring
  line: number; // 1-based
  params: ParamRef; // extracted <angle> and {curly}
  dataTable?: DataTable | null;
  docString?: DocString | null;
};

export type ExamplesTable = {
  tags: string[];
  header: string[];
  rows: Record<string, string>[];
  startLine: number;
  endLine: number;
};

export type ParsedScenario = {
  name: string;
  tags: string[];
  type: "Scenario" | "Scenario Outline";
  file: string;
  id: string; // file:line
  line: number; // scenario start
  steps: ParsedStep[];
  examples: ExamplesTable[]; // empty for plain Scenario
  // Optional “expanded” concrete variants (computed on demand)
  expansions?: {
    name: string;
    steps: ParsedStep[]; // steps with angle params resolved
    exampleRow: Record<string, string>;
    sourceExamplesIndex: number; // which Examples table
  }[];
};

export type CompositeStepIndex = {
  indexVersion: "1.0";
  generatedAt: string;
  scenarios: ParsedScenario[];
  // quick lookup
  byName: Record<string, ParsedScenario[]>;
  byTag: Record<string, ParsedScenario[]>;
};
export type LiteStep = {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string; // raw, single-line (no tables/docstrings here)
  line: number;
};

export type LiteScenario = {
  id: string; // "relative/path.feature:line"
  file: string; // "relative/path.feature"
  line: number; // scenario start line
  name: string;
  type: "Scenario" | "Scenario Outline";
  tags: string[];
  steps: LiteStep[]; // lightweight (no docstrings/tables)
};

export type ScenarioDef = {
  id: string; // file:line
  file: string;
  type: "Scenario" | "Scenario Outline";
  tags: string[];
  previewTemplates: string[]; // first few normalized templates
  examplesHeader: string[]; // if Outline, just column names (optional, leave empty if not parsed)
  referencedBy: string[]; // callers' file:line
};

export type BaseScenariosIndex = {
  version: "1.0";
  generatedAt: string;
  baseScenarios: Array<{
    name: string;
    definitions: ScenarioDef[];
  }>;
  ambiguous: Array<{
    calleeName: string;
    definitions: string[]; // list of ids for quick review
  }>;
};

export type ScenarioCall = {
  caller: { name: string; id: string; file: string };
  calleeName: string; // quoted name in user performs "..."
  stepLine: number;
  candidates: { name: string; id: string; file: string }[]; // resolved after pass
  evidence: string; // file:line of call step
};

export type ScenarioCallsIndex = {
  version: "1.0";
  generatedAt: string;
  calls: ScenarioCall[];
};

export type ArgSlotStats = {
  slot: string; // arg1, arg2, ...
  examples: string[]; // small sample of seen values
  typeGuess?: (
    | "controlKey"
    | "pageKey"
    | "date"
    | "int"
    | "boolean"
    | "enum"
    | "freeText"
  )[];
  enum?: string[]; // if small finite set observed
  len?: { min: number; max: number };
  regex?: string[]; // optional inferred patterns like ^\d{4}-\d{2}-\d{2}$
};

export type BaseStepPattern = {
  signature: string; // hash of normalized template
  template: string; // e.g., Then user inputs "{arg1}" in "{arg2}"
  count: number;
  argSchema: ArgSlotStats[];
  provenance: string[]; // a few scenario ids
  tags?: string[]; // optional simple labels like ["click","input"]
  lastSeen?: string;
};

export type BaseStepsCatalog = {
  version: "1.0";
  generatedAt: string;
  patterns: BaseStepPattern[];
};
