import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LockHeld } from "../src/orchestrator/lock.js";
import { JobStoreUnwritable } from "../src/orchestrator/orchestrator.js";
import { runFactory, type FactoryLoop } from "../src/orchestrator/foreground.js";
import { tmpHome } from "./helpers/tmp.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An Orchestrator stand-in that counts what the runner asks of it. */
function fakeLoop(over: Partial<FactoryLoop> = {}) {
  const calls = { start: 0, runUntilIdle: 0, poll: 0, stop: 0 };
  const loop: FactoryLoop = {
    start: async () => void calls.start++,
    runUntilIdle: async () => void calls.runUntilIdle++,
    poll: async () => void calls.poll++,
    stop: () => void calls.stop++,
    ...over,
  };
  return { loop, calls };
}

describe("factory run", () => {
  test("holds the lock, starts once, housekeeps at startup and on its interval, and keeps the Jobs moving until stopped", async () => {
    const home = tmpHome();
    const { loop, calls } = fakeLoop();
    let sweeps = 0;
    const stop = new AbortController();
    const running = runFactory({ home, loop, housekeeping: async () => void sweeps++, pollMs: 10, housekeepingMs: 60, signal: stop.signal });

    await tick(5);
    expect(existsSync(join(home, "orchestrator.lock"))).toBe(true);
    await expect(runFactory({ home, loop, housekeeping: async () => {}, signal: stop.signal })).rejects.toBeInstanceOf(LockHeld);
    await tick(200);
    stop.abort();
    await running;

    expect(calls.start).toBe(1);
    expect(sweeps).toBeGreaterThanOrEqual(3);
    expect(calls.runUntilIdle).toBeGreaterThan(5);
    expect(calls.stop).toBe(1);
    expect(existsSync(join(home, "orchestrator.lock"))).toBe(false);
  });

  test("polls the Source every interval while a long pass of Stage runs goes on", async () => {
    const home = tmpHome();
    const stop = new AbortController();
    const { loop, calls } = fakeLoop({ runUntilIdle: () => new Promise<void>((r) => stop.signal.addEventListener("abort", () => r())) });
    const running = runFactory({ home, loop, housekeeping: async () => {}, pollMs: 10, signal: stop.signal });

    await tick(100);
    stop.abort();
    await running;

    expect(calls.poll).toBeGreaterThanOrEqual(5);
  });

  test("stops, and releases the lock, when the Job store can't be written", async () => {
    const home = tmpHome();
    const { loop } = fakeLoop({ runUntilIdle: async () => Promise.reject(new JobStoreUnwritable(new Error("disk full"))) });

    await expect(runFactory({ home, loop, housekeeping: async () => {}, pollMs: 10, signal: new AbortController().signal })).rejects.toBeInstanceOf(JobStoreUnwritable);
    expect(existsSync(join(home, "orchestrator.lock"))).toBe(false);
  });

  test("any other error in a pass is reported and the Factory carries on", async () => {
    const home = tmpHome();
    const stop = new AbortController();
    let passes = 0;
    const { loop } = fakeLoop({
      runUntilIdle: async () => {
        if (++passes === 1) throw new Error("GitHub refused the Factory's credentials");
      },
    });
    const reported: string[] = [];
    const running = runFactory({ home, loop, housekeeping: async () => {}, pollMs: 10, signal: stop.signal, report: (m) => void reported.push(m) });
    await tick(60);
    stop.abort();
    await running;

    expect(reported[0]).toMatch(/GitHub refused/);
    expect(passes).toBeGreaterThan(1);
  });
});
