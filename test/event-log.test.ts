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
});
