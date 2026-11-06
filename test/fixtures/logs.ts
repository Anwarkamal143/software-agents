import type { NewEvent } from "../../src/events/envelope.js";

/** Builds one Job's events with the envelope fields filled in. */
export function jobLog(job_id: string, steps: Array<[type: string, data?: Record<string, unknown>]>): NewEvent[] {
  let attempt: number | null = null;
  let run = 0;
  let stageRun: string | null = null;
  return steps.map(([type, data = {}]) => {
    if (type === "attempt-started") attempt = (attempt ?? 0) + 1;
    if (type === "stage-started") stageRun = `${job_id}-run-${++run}`;
    const event: NewEvent = {
      type,
      job_id,
      attempt: type === "job-approved" ? null : attempt,
      stage_run_id: type.startsWith("stage-") ? stageRun : null,
      actor: type.startsWith("human-") || type === "job-approved" ? "human:alice" : "orchestrator",
      data,
    };
    return event;
  });
}

const approve = (issue: number): [string, Record<string, unknown>] => ["job-approved", { repo: "acme/web-app", issue }];
const attempt = (branch: string): [string, Record<string, unknown>] => ["attempt-started", { branch }];

/** One fixture log per Job status, with the state the log must replay to. */
export const STATUS_FIXTURES = {
  queued: {
    log: jobLog("job-q", [approve(1), attempt("factory/1"), ["stage-started", { stage: "triage" }], ["stage-passed", { stage: "triage", cost_usd: 0.25 }]]),
    expected: { job_id: "job-q", repo: "acme/web-app", issue: 1, status: "queued", stage: "triage", reason: null, attempt: 1, cost_usd: 0.25 },
  },
  running: {
    log: jobLog("job-r", [approve(2), attempt("factory/2"), ["stage-started", { stage: "triage" }], ["stage-passed", { stage: "triage", cost_usd: 0.5 }], ["stage-started", { stage: "build" }]]),
    expected: { job_id: "job-r", repo: "acme/web-app", issue: 2, status: "running", stage: "build", reason: null, attempt: 1, cost_usd: 0.5 },
  },
  waiting: {
    log: jobLog("job-w", [approve(3), attempt("factory/3"), ["stage-started", { stage: "triage" }], ["stage-needs-human", { stage: "triage", question: "Which API?", cost_usd: 0.1 }], ["human-requested", { kind: "question" }]]),
    expected: { job_id: "job-w", repo: "acme/web-app", issue: 3, status: "waiting", stage: "triage", reason: "question", attempt: 1, cost_usd: 0.1 },
  },
  paused: {
    log: jobLog("job-p", [approve(4), attempt("factory/4"), ["stage-started", { stage: "build" }], ["stage-errored", { stage: "build", reason: "budget", cost_usd: 5 }], ["budget-exceeded", { budget: "stage_run" }]]),
    expected: { job_id: "job-p", repo: "acme/web-app", issue: 4, status: "paused", stage: "build", reason: "budget", attempt: 1, cost_usd: 5 },
  },
  merged: {
    log: jobLog("job-m", [approve(5), attempt("factory/5"), ["stage-started", { stage: "verify" }], ["stage-passed", { stage: "verify" }], ["pr-opened", { number: 50 }], ["merge-gate-evaluated", { passed: true }], ["pr-merged", { number: 50 }]]),
    expected: { job_id: "job-m", repo: "acme/web-app", issue: 5, status: "merged", stage: "verify", reason: null, attempt: 1, cost_usd: 0 },
  },
  failed: {
    log: jobLog("job-f", [approve(6), attempt("factory/6"), ["stage-started", { stage: "build" }], ["stage-errored", { stage: "build", reason: "crash" }], ["job-failed", { reason: "retries ran out" }]]),
    expected: { job_id: "job-f", repo: "acme/web-app", issue: 6, status: "failed", stage: "build", reason: "retries ran out", attempt: 1, cost_usd: 0 },
  },
  cancelled: {
    log: jobLog("job-c", [approve(7), attempt("factory/7"), ["job-cancelled", { reason: "ready label removed" }]]),
    expected: { job_id: "job-c", repo: "acme/web-app", issue: 7, status: "cancelled", stage: null, reason: "ready label removed", attempt: 1, cost_usd: 0 },
  },
} as const;
