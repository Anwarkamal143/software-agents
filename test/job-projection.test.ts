import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { computeJobs, JobProjection } from "../src/jobs/projection.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { STATUS_FIXTURES } from "./fixtures/logs.js";
import { tmpHome } from "./helpers/tmp.js";

describe("Job projection", () => {
  test.each(Object.entries(STATUS_FIXTURES))("replaying a log that ends %s reproduces that Job state", (_status, fixture) => {
    const store = openSqliteJobStore(join(tmpHome(), "factory.db"));
    for (const event of fixture.log) store.append(event);

    const jobs = computeJobs(store.read());
    expect(jobs.get(fixture.expected.job_id)).toMatchObject(fixture.expected);
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
