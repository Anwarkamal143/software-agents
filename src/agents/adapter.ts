import type { StageBrief } from "../stages/brief.js";

/** What the Orchestrator measured about a Stage run itself, kept apart from the agent's claims (ADR 0003). */
export interface MeasuredFacts {
  /** Always an estimate. */
  cost_usd: number;
  tokens: number;
  turns: number;
  duration_ms: number;
  /** The Job branch's head when the run ended. The Orchestrator measures this, never the agent. */
  head: string | null;
  /** Measured by the Orchestrator from the pushed diff; an adapter's own value is ignored. */
  files_changed: string[];
}

export interface AgentRunRequest {
  stage_run_id: string;
  brief: StageBrief;
  /** The Stage brief rendered as text for the session, issue text wrapped as untrusted. */
  renderedBrief: string;
  model: string;
  /** Where the session runs and may write, and the environment it gets (its own HOME and caches). */
  workingCopy: { dir: string; env: Record<string, string> };
  /** Hard limits for this Stage run. */
  budget: { usd: number; turns: number; minutes: number };
  /** JSON Schema the session's structured output must match. */
  resultSchema: object;
  /**
   * Resume this earlier agent session instead of starting one, sending `input` (a human's
   * answer, marked as human input) as its next turn. The brief still describes the Stage.
   */
  resume?: { session_id: string; input: string };
  signal?: AbortSignal;
}

export type RunErrorReason = "crash" | "sdk-error" | "timeout" | "budget";

export type AgentRunOutcome =
  /** The session ended with structured output. It isn't a Verdict until it passes the Stage result schema. */
  | { kind: "output"; output: unknown; facts: MeasuredFacts; session_id?: string }
  /** The session broke rather than judged: a Run error (ADR 0010). */
  | { kind: "error"; reason: RunErrorReason; message: string; facts: MeasuredFacts; session_id?: string }
  /** The session asked to be resumed couldn't be: nothing ran, so the Orchestrator starts a fresh one. */
  | { kind: "resume-failed"; message: string };

/** The single seam through which the Orchestrator runs one Agent Stage (ADR 0001). */
export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}
