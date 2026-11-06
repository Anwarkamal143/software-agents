import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, MeasuredFacts } from "../../src/agents/adapter.js";
import type { Finding } from "../../src/stages/result.js";
import { commitAll, writeIn } from "../helpers/git.js";

export const facts = (over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  cost_usd: 0.1,
  tokens: 1000,
  turns: 3,
  duration_ms: 1000,
  head: null,
  files_changed: [],
  ...over,
});

export const pass = (summary = "Done.", over: Partial<MeasuredFacts> = {}): AgentRunOutcome => ({
  kind: "output",
  output: { verdict: "pass", summary, findings: [], artifacts: [] },
  facts: facts(over),
});

export const fail = (summary: string, findings: Finding[]): AgentRunOutcome => ({
  kind: "output",
  output: { verdict: "fail", summary, findings, artifacts: [] },
  facts: facts(),
});

export const finding = (root_cause: string, message = `Problem ${root_cause}`): Finding => ({
  severity: "error",
  file: "src/app.ts",
  message,
  root_cause,
});

type Step = AgentRunOutcome | ((req: AgentRunRequest) => AgentRunOutcome | Promise<AgentRunOutcome>);

/**
 * An Agent adapter that returns scripted outcomes per Stage, in order, and
 * records every request. A Stage with no script left passes.
 */
export class ScriptedAgent implements AgentAdapter {
  requests: AgentRunRequest[] = [];
  private readonly script: Record<string, Step[]>;

  constructor(script: Record<string, Step[]> = {}) {
    this.script = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  async run(req: AgentRunRequest): Promise<AgentRunOutcome> {
    this.requests.push(req);
    const step = this.script[req.brief.stage]?.shift() ?? pass(`${req.brief.stage} passed.`);
    return typeof step === "function" ? step(req) : step;
  }

  stagesRun() {
    return this.requests.map((r) => r.brief.stage);
  }
}

/** A build that commits what the verify command looks for, in its own Working copy. */
let builds = 0;
export const building = (req: AgentRunRequest, files: Record<string, string> = {}): AgentRunOutcome => {
  writeIn(req.workingCopy.dir, "built.txt", `build ${++builds}\n`);
  for (const [path, content] of Object.entries(files)) writeIn(req.workingCopy.dir, path, content);
  commitAll(req.workingCopy.dir, "Build");
  return pass("Built it.");
};
