import type { JobState, JobStatus } from "./projection.js";

/**
 * Every way a Stage run ends. A run with none of these is unfinished: cut off by a dying
 * Orchestrator, or still going. While a Job waits for re-approval, these are its held results.
 */
export const STAGE_RUN_ENDINGS: ReadonlySet<string> = new Set(["stage-passed", "stage-failed", "stage-needs-human", "stage-errored", "stage-interrupted", "prepush-failed"]);

/** Stage run endings that broke rather than judged: the next run of that Stage is a retry (ADR 0010). */
export const BROKEN_ENDINGS: ReadonlySet<string> = new Set(["stage-errored", "stage-interrupted"]);

/**
 * Human requests that mean the Factory has given up on its own: the Bounce cap or a repeated root
 * cause, retries run out, Guard denials, a failed Pre-push check, nowhere to Bounce. A `/cancel` of
 * one of these fails the Job, keeping its work to look at for 7 days; any other `/cancel` cancels it.
 */
export const GIVE_UP_CAUSES: ReadonlySet<string> = new Set([
  "bounce-cap",
  "repeated-root-cause",
  "retries-exhausted",
  "repeated-run-error",
  "guard-denials",
  "prepush-failed",
  "no-bounce-target",
]);

/** Events that end a Job. */
export const JOB_ENDINGS: ReadonlySet<string> = new Set(["job-failed", "job-cancelled", "pr-merged"]);

/** Job statuses a Job never leaves on its own: only a human re-label or `factory retry` starts it again. */
export const ENDED_STATUSES: readonly JobStatus[] = ["merged", "failed", "cancelled"];

export const isEnded = (job: Pick<JobState, "status">) => ENDED_STATUSES.includes(job.status);
export const isLive = (job: Pick<JobState, "status">) => !isEnded(job);
