import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentRunOutcome } from "../src/agents/adapter.js";
import { approved, comment } from "./fakes/source.js";
import { building, errored, facts, pass, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory, expectAtMergeGate } from "./helpers/factory.js";

/** A Stage result that doesn't fit the schema. */
const invalid = (summary = "LGTM"): AgentRunOutcome => ({ kind: "output", output: { verdict: "pass", summary }, facts: facts(), session_id: "session-bad" });

describe("Orchestrator: Run errors are retried by reason (ADR 0010)", () => {
  test.each(["crash", "sdk-error"] as const)("a %s resumes the session once, then starts fresh, then asks a human when retries run out", async (reason) => {
    const f = fakeFactory(
      new ScriptedAgent({ triage: [errored(reason, "first", "s1"), errored(reason, "second", "s2"), errored(reason, "third", "s3")] }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const [first, second, third] = f.agent.requests;
    expect(first!.resume).toBeUndefined();
    expect(second!.resume?.session_id).toBe("s1");
    expect(third!.resume).toBeUndefined();
    expect(f.agent.stagesRun()).toEqual(["triage", "triage", "triage"]);
    const events = f.log.store.read();
    expect(events.filter((e) => e.type === "stage-errored").map((e) => e.data.reason)).toEqual([reason, reason, reason]);
    expect(events.find((e) => e.type === "stage-resumed")?.data).toMatchObject({ stage: "triage", session_id: "s1" });
    expect(events.at(-1)).toMatchObject({ type: "human-requested", data: { kind: "approval", cause: "retries-exhausted", stage: "triage" } });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "retries-exhausted" });
  });

  test("an invalid-result resumes the session with the schema errors as a correction turn", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [invalid(), pass("Triaged.")], build: [building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const correction = f.agent.requests[1]!;
    expect(correction.brief.stage).toBe("triage");
    expect(correction.resume?.session_id).toBe("session-bad");
    expect(correction.resume?.input).toContain("result must have required property 'findings'");
    expectAtMergeGate(f.log.store.read());
  });

  test("a timeout starts a fresh session", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [errored("timeout", "no message for 10 minutes", "s1"), pass()], build: [building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.requests[1]!.brief.stage).toBe("triage");
    expect(f.agent.requests[1]!.resume).toBeUndefined();
    expectAtMergeGate(f.log.store.read());
  });

  test("a budget Run error is never retried", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [errored("budget", "maxBudgetUsd reached", "s1", { cost_usd: 5 })] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage"]);
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "budget" });
  });

  test("the same reason in the same place twice skips the remaining retries", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [invalid(), invalid()] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "triage"]);
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "human-requested", data: { cause: "repeated-run-error" } });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "repeated-run-error" });
  });

  test("retries count per Stage per Attempt: a Stage that errored earlier has fewer left", async () => {
    // Two errors in triage use up two of its three runs; a pass in between doesn't give them back.
    const f = fakeFactory(new ScriptedAgent({ triage: [errored("timeout", "a"), errored("timeout", "b"), errored("timeout", "c")] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "triage", "triage"]);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "retries-exhausted" });
  });

  test("/approve after retries run out gives one more try, and its error asks again at once", async () => {
    const f = fakeFactory(
      new ScriptedAgent({ triage: [errored("timeout", "a"), errored("timeout", "b"), errored("timeout", "c"), errored("timeout", "d"), errored("timeout", "e"), pass()], build: [building] }),
    );
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.agent.stagesRun()).toHaveLength(3);

    f.source.push(comment(7, "/approve"));
    await f.orchestrator.runUntilIdle();
    expect(f.agent.stagesRun()).toHaveLength(4);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "retries-exhausted" });

    f.source.push(comment(7, "/approve"));
    await f.orchestrator.runUntilIdle();
    expect(f.agent.stagesRun()).toHaveLength(5);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "retries-exhausted" });
  });

  test("/cancel after retries run out fails the Job, keeping its work to look at", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [errored("timeout", "a"), errored("timeout", "b"), errored("timeout", "c")] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    f.source.push(comment(7, "/cancel"));
    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob()).toMatchObject({ status: "failed" });
    expect(existsSync(join(f.home, "work", f.onlyJob().job_id))).toBe(true);
  });
});
