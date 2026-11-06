import { describe, expect, test } from "vitest";
import type { AgentRunOutcome, AgentRunRequest } from "../src/agents/adapter.js";
import { JobStoreUnwritable } from "../src/orchestrator/orchestrator.js";
import type { JobStore } from "../src/store/job-store.js";
import { approved } from "./fakes/source.js";
import { building, errored, hangs, pass, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory } from "./helpers/factory.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A clock the test moves on. */
function clock() {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), advance: (ms: number) => void (offset += ms) };
}

/** A session that reports a message every few ms until it's aborted. */
const busy = async (req: AgentRunRequest): Promise<AgentRunOutcome> => {
  while (!req.signal?.aborted) {
    req.events.activity();
    await tick(5);
  }
  return errored("crash", "aborted");
};

describe("Orchestrator: watching a Stage run", () => {
  test("a scripted hang is aborted after the idle limit as a timeout, then retried fresh", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [hangs, pass()], build: [building] }), undefined, { limits: { idleMs: 50 } });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const errored = f.log.store.read().find((e) => e.type === "stage-errored")!;
    expect(errored.data).toMatchObject({ stage: "triage", reason: "timeout" });
    expect(String(errored.data.message)).toMatch(/no message from the session/);
    expect(f.agent.requests[1]!.resume).toBeUndefined();
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("a session that keeps talking is still aborted at its wall-clock Budget, as a timeout", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [busy, pass()], build: [building] }), undefined, { limits: { idleMs: 50, wallClockMs: 150 } });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const errored = f.log.store.read().find((e) => e.type === "stage-errored")!;
    expect(errored.data).toMatchObject({ stage: "triage", reason: "timeout" });
    expect(String(errored.data.message)).toMatch(/wall-clock/);
    // A timeout is retried, not treated as a hard Budget hit.
    expect(f.log.store.read().some((e) => e.type === "budget-exceeded")).toBe(false);
  });

  test("transient errors are retried with backoff, three times, without counting", async () => {
    const transient = { ...errored("sdk-error", "API overloaded (529)"), transient: true };
    const sleeps: number[] = [];
    const f = fakeFactory(new ScriptedAgent({ triage: [transient, transient, transient, pass()], build: [building] }), undefined, { sleeps });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun().filter((s) => s === "triage")).toHaveLength(4);
    expect(f.log.store.read().some((e) => e.type === "stage-errored")).toBe(false);
    expect(sleeps).toHaveLength(3);
    // About five minutes in all, each wait longer than the last.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4 * 60_000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6 * 60_000);
    expect([...sleeps].sort((a, b) => a - b)).toEqual(sleeps);
  });

  test("a transient error that outlasts its retries becomes a counted Run error", async () => {
    const transient = { ...errored("sdk-error", "API overloaded (529)"), transient: true };
    const f = fakeFactory(new ScriptedAgent({ triage: [transient, transient, transient, transient, pass()], build: [building] }), undefined, { sleeps: [] });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "stage-errored").map((e) => e.data.reason)).toEqual(["sdk-error"]);
  });

  test("every Guard denial is recorded, and the third in one Stage run ends it with a Human request", async () => {
    const denied = (req: AgentRunRequest) => {
      for (const path of [".env", "../other/.env", "/etc/passwd"]) req.events.guardBlocked({ guard: "secret-file", tool: "Read", why: `${path} is a secret file` });
      return hangs(req);
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [denied] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const blocked = events.filter((e) => e.type === "guard-blocked");
    expect(blocked).toHaveLength(3);
    expect(blocked[0]).toMatchObject({ stage_run_id: expect.any(String), data: { guard: "secret-file", tool: "Read" } });
    expect(events.find((e) => e.type === "stage-interrupted")?.data).toMatchObject({ stage: "triage", reason: "guard-denials" });
    expect(events.at(-1)).toMatchObject({ type: "human-requested", data: { kind: "approval", cause: "guard-denials" } });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "guard-denials" });
  });

  test("two Guard denials are recorded and the Stage run carries on", async () => {
    const twice = (req: AgentRunRequest) => {
      req.events.guardBlocked({ guard: "outside-working-copy", tool: "Write", why: "/tmp/x is outside the Working copy" });
      req.events.guardBlocked({ guard: "destructive-command", tool: "Bash", why: "rm -rf /" });
      return pass();
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [twice], build: [building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "guard-blocked")).toHaveLength(2);
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("a rejected rate limit pauses the Factory until resetsAt, and the cut-off run starts over without counting", async () => {
    const time = clock();
    const resets_at = new Date(Date.now() + 60 * 60_000).toISOString();
    const limited = (req: AgentRunRequest): AgentRunOutcome => {
      req.events.rateLimit({ status: "rejected", resets_at });
      return errored("sdk-error", "rate limited");
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [limited, pass()], build: [building] }), undefined, { now: time.now });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    expect(events.find((e) => e.type === "plan-limit-hit")).toMatchObject({ job_id: null, data: { resets_at } });
    expect(events.find((e) => e.type === "stage-interrupted")?.data).toMatchObject({ stage: "triage", reason: "plan-limit" });
    expect(events.some((e) => e.type === "stage-errored")).toBe(false);
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "plan-limit" });

    // Before resetsAt nothing moves.
    await f.orchestrator.runUntilIdle();
    expect(f.agent.stagesRun()).toEqual(["triage"]);

    time.advance(61 * 60_000);
    await f.orchestrator.runUntilIdle();
    expect(f.log.store.read().some((e) => e.type === "plan-limit-reset")).toBe(true);
    expect(f.agent.stagesRun()).toEqual(["triage", "triage", "build", "review", "security"]);
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("past 90% of the plan limit no new Stage run starts, and the running one finishes", async () => {
    const resets_at = new Date(Date.now() + 60 * 60_000).toISOString();
    const warned = (req: AgentRunRequest): AgentRunOutcome => {
      req.events.rateLimit({ status: "allowed_warning", utilization: 0.93, resets_at });
      return pass();
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [warned] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage"]);
    expect(f.log.store.read().find((e) => e.type === "stage-passed")?.data.stage).toBe("triage");
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "plan-limit" });
  });

  test("an allowed_warning under 90% changes nothing", async () => {
    const warned = (req: AgentRunRequest): AgentRunOutcome => {
      req.events.rateLimit({ status: "allowed_warning", utilization: 0.8 });
      return pass();
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [warned], build: [building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().some((e) => e.type === "plan-limit-hit")).toBe(false);
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("if the Job store can't be written, the Orchestrator stops", async () => {
    let failing = false;
    const wrapStore = (store: JobStore): JobStore => ({
      ...store,
      append: (event) => {
        if (failing) throw new Error("SQLITE_FULL: database or disk is full");
        return store.append(event);
      },
      get: (id) => store.get(id),
      read: (from, limit) => store.read(from, limit),
      follow: (from, o) => store.follow(from, o),
      transaction: (fn) => store.transaction(fn),
      close: () => store.close(),
    });
    const failThenHang = (req: AgentRunRequest) => {
      failing = true;
      return hangs(req);
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [pass()], build: [failThenHang] }), undefined, { wrapStore, limits: { idleMs: 50 } });
    f.source.push(approved(7));

    await expect(f.orchestrator.runUntilIdle()).rejects.toBeInstanceOf(JobStoreUnwritable);
    expect(f.agent.stagesRun()).toEqual(["triage", "build"]);
  });
});
