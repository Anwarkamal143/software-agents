import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunOutcome, AgentRunRequest } from "../src/agents/adapter.js";
import { acquireLock, LockHeld } from "../src/orchestrator/lock.js";
import { approved, comment } from "./fakes/source.js";
import { building, hangs, pass, ScriptedAgent } from "./fakes/agent.js";
import { factoryAt, fakeFactory } from "./helpers/factory.js";
import { tmpHome } from "./helpers/tmp.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A session that reports its id, then works until it's cut off. */
const hangsAs = (session_id: string) => (req: AgentRunRequest): Promise<AgentRunOutcome> => {
  req.events.session(session_id);
  return hangs(req);
};

/** Runs `f` until `stage` has started, then kills its Orchestrator mid-Stage. */
async function killDuring(f: ReturnType<typeof fakeFactory>, stage: string) {
  const running = f.orchestrator.runUntilIdle();
  while (!f.log.store.read().some((e) => e.type === "stage-started" && e.data.stage === stage)) await tick();
  await tick(20); // let the session report its id
  f.orchestrator.stop();
  await running;
}

describe("Orchestrator: restart", () => {
  test("killed mid-Stage, a restarted Orchestrator interrupts that Stage run and resumes its session exactly once", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [hangsAs("s-build")] }));
    f.source.push(approved(7));
    await killDuring(f, "build");
    expect(f.onlyJob()).toMatchObject({ status: "running", stage: "build" });

    const again = factoryAt(f.home, f.remote, new ScriptedAgent({ build: [building] }));
    await again.orchestrator.start();
    await again.orchestrator.runUntilIdle();

    const events = again.log.store.read();
    const interrupted = events.filter((e) => e.type === "stage-interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.data).toEqual({ stage: "build", session_id: "s-build" });
    expect(events.some((e) => e.type === "factory-started")).toBe(true);
    expect(again.agent.stagesRun()).toEqual(["build", "review", "security"]);
    expect(again.agent.requests[0]!.resume?.session_id).toBe("s-build");
    expect(again.agent.requests[0]!.resume?.input).toMatch(/restarted/);
    expect(events.at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("a Stage run whose session never reported an id reruns fresh after a restart", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [hangs] }));
    f.source.push(approved(7));
    await killDuring(f, "build");

    const again = factoryAt(f.home, f.remote, new ScriptedAgent({ build: [building] }));
    await again.orchestrator.start();
    await again.orchestrator.runUntilIdle();

    expect(again.agent.stagesRun()).toEqual(["build", "review", "security"]);
    expect(again.agent.requests[0]!.resume).toBeUndefined();
    expect(again.log.store.read().filter((e) => e.type === "stage-interrupted")).toHaveLength(1);
  });

  test("a resumed session cut off by a second restart reruns fresh: it is resumed only once", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [hangsAs("s-1")] }));
    f.source.push(approved(7));
    await killDuring(f, "build");

    const second = factoryAt(f.home, f.remote, new ScriptedAgent({ build: [hangsAs("s-1")] }));
    await second.orchestrator.start();
    const running = second.orchestrator.runUntilIdle();
    while (!second.log.store.read().some((e) => e.type === "stage-resumed")) await tick();
    second.orchestrator.stop();
    await running;

    const third = factoryAt(f.home, f.remote, new ScriptedAgent({ build: [building] }));
    await third.orchestrator.start();
    await third.orchestrator.runUntilIdle();

    expect(third.agent.requests[0]!.resume).toBeUndefined();
    expect(third.log.store.read().at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("a Stage run cut off while its Job waits for re-approval is interrupted too, and resumes once re-approved", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [
          async (req: AgentRunRequest) => {
            req.events.session("s-held");
            f.source.push({ kind: "edited", repo: "acme/web-app", issue: { number: 7, title: "Issue 7", body: "Changed." }, hash: "h", by: "mallory" });
            await f.orchestrator.poll();
            return hangs(req);
          },
        ],
      }),
    );
    f.source.push(approved(7));
    await killDuring(f, "build");
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "reapproval" });

    const again = factoryAt(f.home, f.remote, new ScriptedAgent({ build: [building] }));
    await again.orchestrator.start();
    expect(again.log.store.read().filter((e) => e.type === "stage-interrupted").map((e) => e.data)).toEqual([{ stage: "build", session_id: "s-held" }]);
    again.source.push(comment(7, "/approve"));
    await again.orchestrator.runUntilIdle();
    expect(again.agent.requests[0]!.resume?.session_id).toBe("s-held");
  });

  test("a Job parked by the plan limit stays parked across a restart until resetsAt", async () => {
    const resets_at = new Date(Date.now() + 60 * 60_000).toISOString();
    const limited = (req: AgentRunRequest): AgentRunOutcome => {
      req.events.rateLimit({ status: "rejected", resets_at });
      return { kind: "error", reason: "sdk-error", message: "rate limited", facts: pass().facts };
    };
    const f = fakeFactory(new ScriptedAgent({ triage: [limited] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    const again = factoryAt(f.home, f.remote, new ScriptedAgent());
    await again.orchestrator.start();
    await again.orchestrator.runUntilIdle();

    expect(again.agent.stagesRun()).toEqual([]);
    expect(again.onlyJob()).toMatchObject({ status: "paused", reason: "plan-limit" });
  });
});

describe("Orchestrator lock", () => {
  test("a second Orchestrator refuses to start while the lock is held, and can once it's released", () => {
    const home = tmpHome();
    const lock = acquireLock(home);
    expect(() => acquireLock(home)).toThrow(LockHeld);
    expect(() => acquireLock(home)).toThrow(`Another Orchestrator (pid ${process.pid}) is running`);
    lock.release();
    acquireLock(home).release();
    expect(existsSync(join(home, "orchestrator.lock"))).toBe(false);
  });

  test("a lock left by an Orchestrator that died is taken over", () => {
    const home = tmpHome();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
    writeFileSync(join(home, "orchestrator.lock"), `${dead}\n`);
    const lock = acquireLock(home);
    lock.release();
  });
});
