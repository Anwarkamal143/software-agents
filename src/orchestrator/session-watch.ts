import type { AgentAdapter, AgentRunEvents, AgentRunOutcome, AgentRunRequest, RateLimitInfo } from "../agents/adapter.js";
import type { NewEvent } from "../events/envelope.js";

/** Why the Orchestrator cut a session off. */
export type Cutoff = "idle" | "wall-clock" | "guard-denials" | "stopping";

/** A session's outcome, and whether the Orchestrator cut it off or the plan limit did. */
export interface Watched {
  outcome: AgentRunOutcome;
  cutoff: Cutoff | null;
  rateLimited: boolean;
}

/** What one Stage run's events are recorded with. */
export type RunEnvelope = Pick<NewEvent, "job_id" | "attempt" | "stage_run_id" | "actor" | "caused_by">;

/** A Stage run's own count of Guard denials, across every session it starts. */
export interface DenialTally {
  denials: number;
}

export interface SessionWatchDeps {
  agent: AgentAdapter;
  /** Records one event (through the Orchestrator, so Mirrors see it). */
  record(event: NewEvent): Promise<unknown>;
  /** The plan limit was reached, or nearly: no new Stage run should start until it resets. */
  planLimitHit(info: RateLimitInfo, caused_by: string | null | undefined): Promise<void>;
  /** Aborted when the Orchestrator stops: every session is cut off. */
  stopping: AbortSignal;
  /** Stuck detection (ADR 0010). Defaults: 10 minutes idle; the wall-clock is the Stage-run Budget's minutes. */
  limits?: { idleMs?: number; wallClockMs?: number };
  sleep?: (ms: number) => Promise<void>;
}

/** The third Guard denial in one Stage run ends it with a Human request (ADR 0007). */
export const MAX_GUARD_DENIALS = 3;
const IDLE_MS = 10 * 60_000;
/** Three tries over about five minutes (ADR 0010). */
const TRANSIENT_BACKOFF_MS = [30_000, 90_000, 180_000];
/** Past this share of the plan's rate limit, no new Stage run starts. */
const PLAN_LIMIT_WARNING = 0.9;

/**
 * Agent sessions as the Orchestrator watches them, on its own timers (the SDK has none,
 * ADR 0001): cut off at the wall-clock Budget, after too long with no message, at the third
 * Guard denial of the Stage run, or when the Orchestrator stops; transient errors retried
 * with backoff without counting (ADR 0010). What a session reports is recorded in order.
 */
export class SessionWatch {
  constructor(private readonly deps: SessionWatchDeps) {}

  limits(budget: { minutes: number }) {
    return { idleMs: this.deps.limits?.idleMs ?? IDLE_MS, wallClockMs: this.deps.limits?.wallClockMs ?? budget.minutes * 60_000 };
  }

  /** One session, retried after transient errors with backoff, about five minutes in all. */
  async run(envelope: RunEnvelope, request: Omit<AgentRunRequest, "events" | "signal">, tally: DenialTally): Promise<Watched> {
    for (let i = 0; ; i++) {
      const watched = await this.once(envelope, request, tally);
      const { outcome } = watched;
      const transient = outcome.kind === "error" && outcome.transient && !watched.cutoff && !watched.rateLimited;
      if (!transient || i >= TRANSIENT_BACKOFF_MS.length || this.deps.stopping.aborted) return watched;
      await (this.deps.sleep ?? sleep)(TRANSIENT_BACKOFF_MS[i]!);
    }
  }

  private async once(envelope: RunEnvelope, request: Omit<AgentRunRequest, "events" | "signal">, tally: DenialTally): Promise<Watched> {
    const limits = this.limits(request.budget);
    const { stopping } = this.deps;
    const controller = new AbortController();
    let cutoff: Cutoff | null = null;
    const cut = (why: Cutoff) => {
      if (cutoff) return;
      cutoff = why;
      controller.abort(why);
    };
    let idle = setTimeout(() => cut("idle"), limits.idleMs);
    const wall = setTimeout(() => cut("wall-clock"), limits.wallClockMs);
    const onStop = () => cut("stopping");
    stopping.addEventListener("abort", onStop);
    if (stopping.aborted) onStop();

    // Reports arrive synchronously; record them one after another, in the order they came.
    let writes = Promise.resolve();
    let writeError: unknown = null;
    const later = (write: () => Promise<unknown>) => {
      writes = writes.then(write).then(
        () => undefined,
        (err: unknown) => {
          writeError ??= err;
          cut("stopping");
        },
      );
    };
    let rateLimited = false;
    const stage = String(request.brief.stage);
    const record = (type: string, data: Record<string, unknown>) => later(() => this.deps.record({ ...envelope, actor: "orchestrator", type, data }));
    const events: AgentRunEvents = {
      activity: () => {
        clearTimeout(idle);
        idle = setTimeout(() => cut("idle"), limits.idleMs);
      },
      session: (session_id) => record("session-started", { stage, session_id }),
      guardBlocked: (denial) => {
        record("guard-blocked", { guard: denial.guard, tool: denial.tool, why: denial.why });
        if (++tally.denials >= MAX_GUARD_DENIALS) cut("guard-denials");
      },
      rateLimit: (info) => {
        if (info.status === "rejected") rateLimited = true;
        if (info.status === "rejected" || (info.status === "allowed_warning" && (info.utilization ?? 0) >= PLAN_LIMIT_WARNING)) {
          later(() => this.deps.planLimitHit(info, envelope.caused_by));
        }
      },
    };
    try {
      const outcome = await this.deps.agent.run({ ...request, events, signal: controller.signal });
      return { outcome, cutoff, rateLimited };
    } finally {
      clearTimeout(idle);
      clearTimeout(wall);
      stopping.removeEventListener("abort", onStop);
      await writes;
      // eslint-disable-next-line no-unsafe-finally
      if (writeError) throw writeError;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
