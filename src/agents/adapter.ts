import type { StageBrief } from "../stages/brief.js";

/** What the Orchestrator measured about a Stage run itself, kept apart from the agent's claims (ADR 0003). */
export interface MeasuredFacts {
  /** Always an estimate. */
  cost_usd: number;
  tokens: number;
  turns: number;
  duration_ms: number;
  /** The Working copy's head commit when the run ended, if known. */
  head: string | null;
  files_changed: string[];
}

export interface AgentRunRequest {
  stage_run_id: string;
  brief: StageBrief;
  /** The Stage brief rendered as text for the session, issue text wrapped as untrusted. */
  renderedBrief: string;
  model: string;
  /** Hard limits for this Stage run. */
  budget: { usd: number; turns: number; minutes: number };
  /** JSON Schema the session's structured output must match. */
  resultSchema: object;
  signal?: AbortSignal;
}

export type RunErrorReason = "crash" | "sdk-error" | "timeout" | "budget";

export type AgentRunOutcome =
  /** The session ended with structured output. It isn't a Verdict until it passes the Stage result schema. */
  | { kind: "output"; output: unknown; facts: MeasuredFacts }
  /** The session broke rather than judged: a Run error (ADR 0010). */
  | { kind: "error"; reason: RunErrorReason; message: string; facts: MeasuredFacts };

/** The single seam through which the Orchestrator runs one Agent Stage (ADR 0001). */
export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}
