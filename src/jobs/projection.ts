import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import { STAGE_RUN_ENDINGS } from "./endings.js";

/** Where a Job stands, independent of the Pipeline. Computed from events, never stored (ADR 0009). */
export type JobStatus = "queued" | "running" | "waiting" | "paused" | "merged" | "failed" | "cancelled";

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
  bounced: { from: ["queued"], to: "queued" },
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
 * Factory-wide events that stop new Stage runs, and the event that releases them.
 * Queued Jobs park at once; running ones finish their Stage run and park then (ADR 0004).
 */
const FACTORY_PAUSES: Record<string, { reason: string; releasedBy: string }> = {
  "plan-limit-hit": { reason: "plan-limit", releasedBy: "plan-limit-reset" },
  "factory-paused": { reason: "factory-paused", releasedBy: "factory-resumed" },
};

/**
 * Folds the Event log into Job states. Feed it events in seq order; it never
 * reads anything else, so replaying the same log always gives the same states.
 */
export class JobProjection {
  private readonly states = new Map<string, JobState>();
  /** Reason of the Factory-wide pause in effect, if any. */
  private factoryPause: string | null = null;
  /** The event that started it. */
  private factoryPauseEvent: FactoryEvent | null = null;

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
    if (move) {
      const was = job.status;
      job.resumed = move.to === "queued" && (was === "waiting" || was === "paused" || (job.resumed && was === "queued"));
      job.status = move.to;
      job.reason = move.reason?.(event.data) ?? null;
      if (job.status === "queued" && this.factoryPause) {
        job.status = "paused";
        job.reason = this.factoryPause;
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

  /** The `plan-limit-hit` or `factory-paused` event in effect, or null when the Factory isn't paused. */
  pause(): FactoryEvent | null {
    return this.factoryPauseEvent;
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
    const release = Object.values(FACTORY_PAUSES).find((p) => p.releasedBy === event.type);
    if (pause) {
      this.factoryPause = pause.reason;
      this.factoryPauseEvent = event;
    } else if (release && this.factoryPause === release.reason) {
      this.factoryPause = null;
      this.factoryPauseEvent = null;
    }
    for (const job of this.states.values()) {
      if (pause && job.status === "queued") {
        job.status = "paused";
        job.reason = pause.reason;
      } else if (release && job.status === "paused" && job.reason === release.reason) {
        job.status = "queued";
        job.reason = null;
        job.resumed = true;
      } else continue;
      job.last_seq = event.seq;
      job.updated_at = event.at;
    }
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
