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
  job_id: string;
  stage_run_id: string;
  brief: StageBrief;
  /** The Stage brief rendered as text for the session, issue text wrapped as untrusted. */
  renderedBrief: string;
  model: string;
  /**
   * Where the session runs and may write, and the environment it gets (its own HOME and caches).
   * `objects` is the Trusted clone's object store, which the Working copy borrows through
   * `--reference` (ADR 0008): its commands may read it, never write it.
   */
  workingCopy: { dir: string; env: { HOME: string; XDG_CONFIG_HOME: string; XDG_CACHE_HOME: string; npm_config_cache: string; TMPDIR: string }; objects: string };
  /** The only hosts the session's commands may reach: the repo's allowlist for a Stage that writes the branch, else none (ADR 0007). */
  network: string[];
  /** Hard limits for this Stage run. */
  budget: { usd: number; turns: number; minutes: number };
  /** JSON Schema the session's structured output must match. */
  resultSchema: object;
  /**
   * Resume this earlier agent session instead of starting one, sending `input` (a human's
   * answer, marked as human input) as its next turn. The brief still describes the Stage.
   */
  resume?: SessionResume;
  /** What the session reports while it runs, as it happens. */
  events: AgentRunEvents;
  /** The Orchestrator's own timers and stops: the session ends soon after this aborts. */
  signal?: AbortSignal;
}

/** An agent session to carry on, and the turn it carries on with. */
export interface SessionResume {
  session_id: string;
  input: string;
}

/** Things a running session reports to the Orchestrator, which decides what they mean. */
export interface AgentRunEvents {
  /** The session sent a message: it isn't stuck. */
  activity(): void;
  /** The session's id, once known, so a restart can resume it. */
  session(session_id: string): void;
  /** A Guard denied one tool call (ADR 0007). */
  guardBlocked(denial: GuardDenial): void;
  /** The plan's rate limit changed. */
  rateLimit(info: RateLimitInfo): void;
}

/** The Guards (ADR 0007). */
export type GuardName = "secret-file" | "outside-working-copy" | "destructive-command";

export interface GuardDenial {
  guard: GuardName;
  tool: string;
  why: string;
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  /** 0 to 1, how much of the limit is used. */
  utilization?: number;
  /** ISO-8601: when the limit resets. */
  resets_at?: string;
}

export type RunErrorReason = "crash" | "sdk-error" | "timeout" | "budget";

export type AgentRunOutcome =
  /** The session ended with structured output. It isn't a Verdict until it passes the Stage result schema. */
  | { kind: "output"; output: unknown; facts: MeasuredFacts; session_id?: string }
  /** The session broke rather than judged: a Run error (ADR 0010). */
  | {
      kind: "error";
      reason: RunErrorReason;
      message: string;
      facts: MeasuredFacts;
      session_id?: string;
      /** An API overload, 5xx or network blip: retried with backoff without counting (ADR 0010). */
      transient?: boolean;
      /** What failed, when the message alone doesn't say it the same way twice. Same reason in the same place skips retries. */
      where?: string;
    }
  /** A Factory fault (ADR 0010): nothing about this Stage is wrong, but no session can run here. */
  | { kind: "fault"; reason: "sandbox-unavailable" | "sign-in-mismatch"; message: string }
  /** The session asked to be resumed couldn't be: nothing ran, so the Orchestrator starts a fresh one. */
  | { kind: "resume-failed"; message: string };

/** The single seam through which the Orchestrator runs one Agent Stage (ADR 0001). */
export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}
