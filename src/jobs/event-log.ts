import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { JobStore } from "../store/job-store.js";
import { JobProjection, type JobState } from "./projection.js";

/**
 * The Orchestrator's writing side of the Job store: every event is checked
 * against the Job state computed from the log before it is appended, and a
 * move the rules don't allow is recorded as `transition-rejected` instead (ADR 0009).
 */
export class EventLog {
  private readonly projection = new JobProjection();
  private nextSeq = 1;

  constructor(readonly store: JobStore) {}

  /** Appends `event`, or a `transition-rejected` in its place. Returns what was appended. */
  record(event: NewEvent): FactoryEvent {
    this.catchUp();
    // Replaying an event already in the log has no effect, not even a rejection.
    const stored = event.id ? this.store.get(event.id) : undefined;
    if (stored) return stored;
    const rejected = this.projection.rejection(event);
    const appended = rejected
      ? this.store.append({
          type: "transition-rejected",
          job_id: event.job_id ?? null,
          attempt: event.attempt ?? null,
          stage_run_id: event.stage_run_id ?? null,
          actor: event.actor,
          caused_by: event.caused_by ?? null,
          data: { rejected_type: event.type, ...rejected, rejected_data: event.data ?? {} },
        })
      : this.store.append(event);
    this.catchUp();
    return appended;
  }

  job(job_id: string): JobState | undefined {
    this.catchUp();
    return this.projection.get(job_id);
  }

  jobs(): JobState[] {
    this.catchUp();
    return this.projection.all();
  }

  private catchUp(): void {
    for (const event of this.store.read(this.nextSeq)) {
      this.projection.apply(event);
      this.nextSeq = event.seq + 1;
    }
  }
}
