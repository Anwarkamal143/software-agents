import type { JobState, JobStatus } from "./projection.js";

/**
 * Every way a Stage run ends. A run with none of these is unfinished: cut off by a dying
 * Orchestrator, or still going. While a Job waits for re-approval, these are its held results.
 */
export const STAGE_RUN_ENDINGS: ReadonlySet<string> = new Set(["stage-passed", "stage-failed", "stage-needs-human", "stage-errored", "stage-interrupted", "prepush-failed"]);

/** Stage run endings that broke rather than judged: the next run of that Stage is a retry (ADR 0010). */
export const BROKEN_ENDINGS: ReadonlySet<string> = new Set(["stage-errored", "stage-interrupted"]);

/** Events that end a Job. */
export const JOB_ENDINGS: ReadonlySet<string> = new Set(["job-failed", "job-cancelled", "pr-merged"]);

/** Job statuses a Job never leaves on its own: only a human re-label or `factory retry` starts it again. */
export const ENDED_STATUSES: readonly JobStatus[] = ["merged", "failed", "cancelled"];

export const isEnded = (job: Pick<JobState, "status">) => ENDED_STATUSES.includes(job.status);
export const isLive = (job: Pick<JobState, "status">) => !isEnded(job);
