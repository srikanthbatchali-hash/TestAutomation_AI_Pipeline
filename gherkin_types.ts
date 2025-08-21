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
