import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { V1_EVENTS } from "../src/events/registry.js";
import { tmpHome } from "./helpers/tmp.js";
import type { NewEvent } from "../src/events/envelope.js";

const open = (home = tmpHome()) => openSqliteJobStore(join(home, "factory.db"));

const approved = (job_id: string): NewEvent => ({
  type: "job-approved",
  job_id,
  actor: "human:alice",
  data: { repo: "acme/web-app", issue: 7 },
});

describe("JobStore", () => {
  test("reads back appended events in seq order with a full envelope", () => {
    const store = open();
    store.append(approved("job-1"));
    store.append(approved("job-2"));

    const events = store.read(1);
    expect(events.map((e) => [e.seq, e.job_id, e.type])).toEqual([
      [1, "job-1", "job-approved"],
      [2, "job-2", "job-approved"],
    ]);
    const [first] = events;
    expect(first).toMatchObject({
      schema_version: 1,
      attempt: null,
      stage_run_id: null,
      caused_by: null,
      actor: "human:alice",
      data: { repo: "acme/web-app", issue: 7 },
    });
    expect(first!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Date.parse(first!.at)).not.toBeNaN();
  });

  test("appending an event whose id is already in the log has no effect", () => {
    const store = open();
    const first = store.append({ ...approved("job-1"), id: "01JZ0000000000000000000001" });
    const again = store.append({ ...approved("job-1"), id: "01JZ0000000000000000000001", data: { repo: "x/y", issue: 9 } });

    expect(again).toEqual(first);
    expect(store.read()).toHaveLength(1);
  });

  test("an event stored at an old schema_version is upgraded on read", () => {
    const home = tmpHome();
    const v1 = open(home);
    v1.append(approved("job-1"));
    v1.close();

    // A later Factory where job-approved v2 renamed `issue` to `issue_number`.
    const v2 = openSqliteJobStore(join(home, "factory.db"), {
      registry: {
        ...V1_EVENTS,
        "job-approved": {
          version: 2,
          data: { type: "object", required: ["repo", "issue_number"] },
          upgrades: { 1: ({ issue, ...rest }) => ({ ...rest, issue_number: issue }) },
        },
      },
    });
    expect(v2.read()[0]).toMatchObject({
      schema_version: 2,
      data: { repo: "acme/web-app", issue_number: 7 },
    });
  });

  test("an event type this Factory doesn't know is kept but skipped on read", () => {
    const home = tmpHome();
    const newer = openSqliteJobStore(join(home, "factory.db"), {
      registry: { ...V1_EVENTS, "panel-opened": { version: 1, data: { type: "object" } } },
    });
    newer.append(approved("job-1"));
    newer.append({ type: "panel-opened", actor: "cli" });
    newer.append(approved("job-2"));
    newer.close();

    const older = open(home);
    expect(older.read().map((e) => [e.seq, e.type])).toEqual([
      [1, "job-approved"],
      [3, "job-approved"],
    ]);
  });

  test("follow delivers events from fromSeq, then ones appended after the call, in seq order", async () => {
    const store = open();
    store.append(approved("job-1"));
    store.append(approved("job-2"));

    const controller = new AbortController();
    const seen: number[] = [];
    const following = (async () => {
      for await (const event of store.follow(2, { signal: controller.signal })) {
        seen.push(event.seq);
        if (seen.length === 3) controller.abort();
      }
    })();

    await new Promise((r) => setTimeout(r, 20));
    store.append(approved("job-3"));
    store.append(approved("job-4"));
    await following;

    expect(seen).toEqual([2, 3, 4]);
  });

  test("follow sees events another process appends to the same file", async () => {
    const home = tmpHome();
    const reader = open(home);
    const writer = open(home);

    const controller = new AbortController();
    const seen: string[] = [];
    const following = (async () => {
      for await (const event of reader.follow(1, { signal: controller.signal, pollMs: 10 })) {
        seen.push(event.job_id!);
        controller.abort();
      }
    })();
    writer.append(approved("job-from-elsewhere"));
    await following;

    expect(seen).toEqual(["job-from-elsewhere"]);
  });
});
