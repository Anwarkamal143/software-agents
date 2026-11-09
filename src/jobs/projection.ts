import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import { STAGE_RUN_ENDINGS } from "./endings.js";

/** Where a Job stands, independent of the Pipeline. Computed from events, never stored (ADR 0009). */
export const JOB_STATUSES = ["queued", "running", "waiting", "paused", "merged", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobState {
  job_id: string;
  repo: string;
  issue: number;
  status: JobStatus;
  /** The Stage the Job is at or last ran; null before its first Stage run. */
  stage: string | null;
  /** Why the Job is waiting, paused, failed or cancelled. */
  reason: string | null;
  /** Back in the queue after waiting or paused: such Jobs start ahead of new ones (ADR 0008). */
  resumed: boolean;
  /** Current Attempt number; 0 before the first Attempt starts. */
  attempt: number;
  /** Sum of the estimated cost on Stage-ending events. Always an estimate. */
  cost_usd: number;
  last_seq: number;
  updated_at: string;
}

type Data = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

interface Move {
  /** Statuses the move is allowed from. */
  from: readonly JobStatus[];
  to: JobStatus;
  reason?: (data: Data) => string | null;
  /** A paused Job stays paused, for the same reason: the move changes its Stage, not whether it may run. */
  keepsPause?: boolean;
}

const LIVE: readonly JobStatus[] = ["queued", "running", "waiting", "paused"];

/** Every event type that moves a Job's status, and where from. Anything else leaves status alone. */
const MOVES: Record<string, Move> = {
  "attempt-started": { from: ["queued", "failed"], to: "queued" },
  // Only a human starts a new Attempt (ADR 0010).
  "job-retried": { from: ["failed", "cancelled"], to: "queued" },
  "stage-started": { from: ["queued"], to: "running" },
  "stage-resumed": { from: ["queued"], to: "running" },
  "stage-passed": { from: ["running"], to: "queued" },
  "stage-failed": { from: ["running"], to: "queued" },
  "stage-errored": { from: ["running"], to: "queued" },
  "stage-interrupted": { from: ["running"], to: "queued" },
  "stage-needs-human": { from: ["running"], to: "waiting", reason: () => "question" },
  // A failed Pre-push check ends the Stage run: nothing is pushed and a human decides (ADR 0007).
  "prepush-failed": { from: ["running"], to: "waiting", reason: () => "prepush-failed" },
  // A Stage run that ends while the Factory is paused parks its Job, and its fail Verdict must still Bounce.
  bounced: { from: ["queued", "paused"], to: "queued", keepsPause: true },
  "human-requested": { from: LIVE, to: "waiting", reason: (d) => text(d.cause) ?? text(d.kind) },
  "human-answered": { from: ["waiting", "paused"], to: "queued" },
  "job-reapproval-needed": { from: LIVE, to: "waiting", reason: () => "reapproval" },
  // Budgets are checked before a Stage run, and a hard hit ends the run first (stage-errored),
  // so a running Stage run always finishes (ADR 0004).
  "budget-exceeded": { from: ["queued"], to: "paused", reason: () => "budget" },
  "pr-merged": { from: LIVE, to: "merged" },
  "job-failed": { from: LIVE, to: "failed", reason: (d) => text(d.reason) },
  "job-cancelled": { from: LIVE, to: "cancelled", reason: (d) => text(d.reason) },
};

/**
 * Factory-wide events that stop new Stage runs, and the Job reason each gives; `plan-limit-reset`
 * and `factory-resumed` lift them. Queued Jobs park at once; running ones finish their Stage run and park then (ADR 0004).
 */
const FACTORY_PAUSES: Record<string, { reason: string }> = {
  "plan-limit-hit": { reason: "plan-limit" },
  "factory-paused": { reason: "factory-paused" },
};

/** The Job reasons a Factory-wide pause gives. */
const PAUSE_REASONS = new Set(Object.values(FACTORY_PAUSES).map((p) => p.reason));

/** Pauses of one kind replace each other: the plan limit, or `factory-paused` for one reason. */
function pauseKind(event: FactoryEvent): string {
  return event.type === "factory-paused" ? `factory-paused:${String(event.data.reason)}` : event.type;
}

/**
 * Folds the Event log into Job states. Feed it events in seq order; it never
 * reads anything else, so replaying the same log always gives the same states.
 */
export class JobProjection {
  private readonly states = new Map<string, JobState>();
  /**
   * The Factory-wide pauses in effect, oldest first: one per kind (a plan limit, or a
   * `factory-paused` per reason). Jobs stay parked until the last is lifted.
   */
  private active: FactoryEvent[] = [];

  apply(event: FactoryEvent): void {
    if (event.job_id === null) return this.applyFactoryWide(event);
    // A rejected move is a fact about the log, not about the Job: it changes nothing.
    if (event.type === "transition-rejected") return;
    if (event.type === "job-approved") {
      if (this.states.has(event.job_id)) return;
      this.states.set(event.job_id, {
        job_id: event.job_id,
        repo: String(event.data.repo),
        issue: Number(event.data.issue),
        status: "queued",
        stage: null,
        reason: null,
        resumed: false,
        attempt: 0,
        cost_usd: 0,
        last_seq: event.seq,
        updated_at: event.at,
      });
      return;
    }
    const job = this.states.get(event.job_id);
    if (!job || disallowedMove(job, event)) return;

    const move = held(job, event) ? undefined : MOVES[event.type];
    if (move && !(move.keepsPause && job.status === "paused")) {
      const was = job.status;
      job.resumed = move.to === "queued" && (was === "waiting" || was === "paused" || (job.resumed && was === "queued"));
      job.status = move.to;
      job.reason = move.reason?.(event.data) ?? null;
      const parked = this.parkedFor();
      if (job.status === "queued" && parked) {
        job.status = "paused";
        job.reason = parked;
      }
    }
    if (event.type === "attempt-started") {
      job.attempt = event.attempt ?? job.attempt + 1;
      job.stage = null;
    }
    if (typeof event.data.stage === "string") job.stage = event.data.stage;
    if (event.type === "bounced") job.stage = text(event.data.to);
    if (typeof event.data.cost_usd === "number") job.cost_usd += event.data.cost_usd;
    job.last_seq = event.seq;
    job.updated_at = event.at;
  }

  /** The latest `plan-limit-hit` or `factory-paused` event in effect, or null when the Factory isn't paused. */
  pause(): FactoryEvent | null {
    return this.active.at(-1) ?? null;
  }

  /** Every pause in effect, oldest first. */
  pauses(): FactoryEvent[] {
    return [...this.active];
  }

  get(job_id: string): JobState | undefined {
    const job = this.states.get(job_id);
    return job && { ...job };
  }

  all(): JobState[] {
    return [...this.states.values()].map((j) => ({ ...j }));
  }

  /** Why `event` would be a disallowed move, or null if it is allowed. */
  rejection(event: NewEvent): { from_status: string; why: string } | null {
    if (!event.job_id) return null;
    const job = this.states.get(event.job_id);
    if (event.type === "job-approved") {
      return job ? { from_status: job.status, why: `Job ${event.job_id} already exists` } : null;
    }
    if (!job) return { from_status: "none", why: `no Job ${event.job_id} has been approved` };
    return disallowedMove(job, event);
  }

  private applyFactoryWide(event: FactoryEvent): void {
    const pause = FACTORY_PAUSES[event.type];
    if (pause) {
      // The same kind again replaces the one in effect; other kinds stay.
      this.active = this.active.filter((p) => pauseKind(p) !== pauseKind(event)).concat(event);
    } else if (event.type === "plan-limit-reset") {
      this.active = this.active.filter((p) => p.type !== "plan-limit-hit");
    } else if (event.type === "factory-resumed") {
      // It lifts the pause it names; one naming none (or one already gone) lifts every factory-paused.
      const named = this.active.some((p) => p.id === event.caused_by);
      this.active = this.active.filter((p) => (named ? p.id !== event.caused_by : p.type !== "factory-paused"));
    } else return;
    const parked = this.parkedFor();
    for (const job of this.states.values()) {
      if (pause && job.status === "queued") {
        job.status = "paused";
        job.reason = pause.reason;
      } else if (!pause && job.status === "paused" && PAUSE_REASONS.has(job.reason ?? "") && job.reason !== parked) {
        // Its pause was lifted: it carries on, or stays parked by the one still in effect.
        if (parked) job.reason = parked;
        else {
          job.status = "queued";
          job.reason = null;
          job.resumed = true;
        }
      } else continue;
      job.last_seq = event.seq;
      job.updated_at = event.at;
    }
  }

  /** The Job reason of the latest pause in effect, or null. */
  private parkedFor(): string | null {
    const latest = this.active.at(-1);
    return latest ? FACTORY_PAUSES[latest.type]!.reason : null;
  }
}

/**
 * A Stage run that was going when the issue was edited by someone not allowed ends while the
 * Job waits for re-approval: its ending is recorded, but the Job stays waiting.
 */
function held(job: JobState, event: Pick<NewEvent, "type">): boolean {
  return job.status === "waiting" && job.reason === "reapproval" && STAGE_RUN_ENDINGS.has(event.type);
}

function disallowedMove(job: JobState, event: Pick<NewEvent, "type">): { from_status: string; why: string } | null {
  if (held(job, event)) return null;
  const move = MOVES[event.type];
  if (!move || move.from.includes(job.status)) return null;
  return { from_status: job.status, why: `${event.type} is not allowed while the Job is ${job.status}` };
}

/** Job states computed from a whole log, keyed by Job id. */
export function computeJobs(events: Iterable<FactoryEvent>): Map<string, JobState> {
  const projection = new JobProjection();
  for (const event of events) projection.apply(event);
  return new Map(projection.all().map((j) => [j.job_id, j]));
}
