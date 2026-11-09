import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { computeJobs, JobProjection } from "../src/jobs/projection.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { jobLog, STATUS_FIXTURES } from "./fixtures/logs.js";
import { tmpHome } from "./helpers/tmp.js";

describe("Job projection", () => {
  test.each(Object.entries(STATUS_FIXTURES))("replaying a log that ends %s reproduces that Job state", (_status, fixture) => {
    const store = openSqliteJobStore(join(tmpHome(), "factory.db"));
    for (const event of fixture.log) store.append(event);

    const jobs = computeJobs(store.read());
    expect(jobs.get(fixture.expected.job_id)).toMatchObject(fixture.expected);
  });

  test("a Bounce recorded while a Job is paused moves its Stage and keeps the pause, whatever its reason", () => {
    const store = openSqliteJobStore(join(tmpHome(), "factory.db"));
    const log = jobLog("job-b", [["job-approved", { repo: "acme/web-app", issue: 8 }], ["attempt-started", { branch: "factory/8" }], ["stage-started", { stage: "review" }]]);
    for (const event of log) store.append(event);
    store.append({ type: "plan-limit-hit", actor: "orchestrator", data: {} });
    for (const event of jobLog("job-b", [["stage-failed", { stage: "review" }], ["bounced", { from: "review", to: "build", bounce: 1 }]])) store.append({ ...event, attempt: 1 });
    expect(computeJobs(store.read()).get("job-b")).toMatchObject({ status: "paused", reason: "plan-limit", stage: "build" });

    store.append({ type: "plan-limit-reset", actor: "orchestrator" });
    expect(computeJobs(store.read()).get("job-b")).toMatchObject({ status: "queued", reason: null, stage: "build" });

    // A budget pause isn't lifted by a Bounce either.
    const budget = openSqliteJobStore(join(tmpHome(), "factory.db"));
    for (const event of STATUS_FIXTURES.paused.log) budget.append(event);
    for (const event of jobLog("job-p", [["bounced", { from: "review", to: "build", bounce: 1 }]])) budget.append({ ...event, attempt: 1 });
    expect(computeJobs(budget.read()).get("job-p")).toMatchObject({ status: "paused", reason: "budget", stage: "build" });
  });

  test("a plan-limit hit parks queued Jobs and leaves running ones to finish; its reset releases only those", () => {
    const store = openSqliteJobStore(join(tmpHome(), "factory.db"));
    for (const f of [STATUS_FIXTURES.queued, STATUS_FIXTURES.running, STATUS_FIXTURES.waiting]) {
      for (const event of f.log) store.append(event);
    }
    store.append({ type: "plan-limit-hit", actor: "orchestrator", data: { resets_at: "2026-11-06T20:00:00Z" } });
    const during = computeJobs(store.read());
    expect([...during.values()].map((j) => [j.job_id, j.status, j.reason])).toEqual([
      ["job-q", "paused", "plan-limit"],
      ["job-r", "running", null],
      ["job-w", "waiting", "question"],
    ]);

    store.append({ type: "plan-limit-reset", actor: "orchestrator" });
    const after = computeJobs(store.read());
    expect([...after.values()].map((j) => [j.job_id, j.status, j.reason])).toEqual([
      ["job-q", "queued", null],
      ["job-r", "running", null],
      ["job-w", "waiting", "question"],
    ]);
  });

  test("pauses for different reasons overlap: lifting one leaves the Factory paused for the other", () => {
    const store = openSqliteJobStore(join(tmpHome(), "factory.db"));
    for (const event of STATUS_FIXTURES.queued.log) store.append(event);
    const sandbox = store.append({ type: "factory-paused", actor: "orchestrator", data: { reason: "sandbox-unavailable", message: "bubblewrap is not installed" } });
    const source = store.append({ type: "factory-paused", actor: "orchestrator", data: { reason: "source-credentials", message: "GitHub refused" } });
    const project = () => {
      const projection = new JobProjection();
      for (const e of store.read()) projection.apply(e);
      return projection;
    };
    expect(project().pauses().map((p) => p.data.reason)).toEqual(["sandbox-unavailable", "source-credentials"]);

    store.append({ type: "factory-resumed", actor: "orchestrator", caused_by: source.id });
    expect(project().pauses().map((p) => p.id)).toEqual([sandbox.id]);
    expect(project().get("job-q")).toMatchObject({ status: "paused", reason: "factory-paused" });

    store.append({ type: "plan-limit-hit", actor: "orchestrator", data: {} });
    store.append({ type: "factory-resumed", actor: "orchestrator", caused_by: sandbox.id });
    expect(project().get("job-q")).toMatchObject({ status: "paused", reason: "plan-limit" });

    store.append({ type: "plan-limit-reset", actor: "orchestrator" });
    expect(project().pauses()).toEqual([]);
    expect(project().get("job-q")).toMatchObject({ status: "queued", reason: null, resumed: true });
  });
});
