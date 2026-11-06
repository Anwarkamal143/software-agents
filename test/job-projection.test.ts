import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { computeJobs } from "../src/jobs/projection.js";
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
});
