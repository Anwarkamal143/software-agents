import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { EventLog } from "../src/jobs/event-log.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { STATUS_FIXTURES } from "./fixtures/logs.js";
import { tmpHome } from "./helpers/tmp.js";

const openLog = () => new EventLog(openSqliteJobStore(join(tmpHome(), "factory.db")));

describe("EventLog.record", () => {
  test("a disallowed transition is recorded as transition-rejected and changes nothing", () => {
    const log = openLog();
    for (const event of STATUS_FIXTURES.merged.log) log.record(event);
    const before = log.job("job-m");

    const recorded = log.record({ type: "stage-started", job_id: "job-m", attempt: 1, actor: "orchestrator", data: { stage: "build" } });

    expect(recorded).toMatchObject({
      type: "transition-rejected",
      job_id: "job-m",
      actor: "orchestrator",
      data: {
        rejected_type: "stage-started",
        from_status: "merged",
        why: "stage-started is not allowed while the Job is merged",
        rejected_data: { stage: "build" },
      },
    });
    expect(log.job("job-m")).toEqual(before);
    expect(log.job("job-m")).toMatchObject({ status: "merged", stage: "verify" });
  });

  test("an event for a Job that was never approved is rejected", () => {
    const log = openLog();
    const recorded = log.record({ type: "stage-started", job_id: "ghost", actor: "orchestrator", data: { stage: "build" } });
    expect(recorded.data).toMatchObject({ rejected_type: "stage-started", from_status: "none" });
    expect(log.jobs()).toEqual([]);
  });

  test("an allowed transition is appended as given and moves the Job", () => {
    const log = openLog();
    for (const event of STATUS_FIXTURES.queued.log) log.record(event);
    const recorded = log.record({ type: "stage-started", job_id: "job-q", attempt: 1, actor: "orchestrator", data: { stage: "build" } });
    expect(recorded.type).toBe("stage-started");
    expect(log.job("job-q")).toMatchObject({ status: "running", stage: "build" });
  });

  test("recording an event whose id is already in the log has no effect", () => {
    const log = openLog();
    const [approval] = STATUS_FIXTURES.queued.log;
    const first = log.record({ ...approval!, id: "01JZ0000000000000000000009" });
    const again = log.record({ ...approval!, id: "01JZ0000000000000000000009" });

    expect(again).toEqual(first);
    expect(log.store.read().map((e) => e.type)).toEqual(["job-approved"]);
  });

  test("a Stage run in flight when the Factory pauses still finishes, then the Job parks (ADR 0004)", () => {
    const log = openLog();
    for (const event of STATUS_FIXTURES.running.log) log.record(event);
    log.record({ type: "plan-limit-hit", actor: "orchestrator" });
    expect(log.job("job-r")).toMatchObject({ status: "running" });

    const finished = log.record({ type: "stage-passed", job_id: "job-r", attempt: 1, actor: "orchestrator", data: { stage: "build" } });
    expect(finished.type).toBe("stage-passed");
    expect(log.job("job-r")).toMatchObject({ status: "paused", reason: "plan-limit", stage: "build" });

    log.record({ type: "plan-limit-reset", actor: "orchestrator" });
    expect(log.job("job-r")).toMatchObject({ status: "queued", reason: null });
  });

  test("a Budget is enforced between Stage runs, so a running Job can't be paused mid-run", () => {
    const log = openLog();
    for (const event of STATUS_FIXTURES.running.log) log.record(event);
    const recorded = log.record({ type: "budget-exceeded", job_id: "job-r", attempt: 1, actor: "orchestrator", data: { budget: "daily" } });
    expect(recorded.type).toBe("transition-rejected");
  });
});
