import { describe, expect, test } from "vitest";
import type { AgentRunOutcome } from "../src/agents/adapter.js";
import { approved } from "./fakes/source.js";
import { building, facts, pass, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory } from "./helpers/factory.js";
import { fixture } from "./helpers/config.js";

/** The e2e config with Factory-layer Budgets. */
const withBudgets = (budgets: string) => fixture("e2e.yaml").replace("policies:\n  bounce_cap: 3", `policies:\n  bounce_cap: 3\n  budgets: ${budgets}`);

describe("Orchestrator: Budgets", () => {
  test("a Job that has spent its Budget starts no new Stage run and goes to paused (budget)", async () => {
    // Each agent Stage run costs an estimated $0.10; verify is free. After review the Job has spent $0.30.
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withBudgets("{ job: { usd: 0.25 } }"));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "review"]);
    const exceeded = f.log.store.read().at(-1)!;
    expect(exceeded).toMatchObject({ type: "budget-exceeded", actor: "orchestrator", data: { budget: "job", checkpoint: "before-stage-run", limit_usd: 0.25 } });
    expect(exceeded.data.why).toBe("this Job has spent an estimated $0.30 of its $0.25 Budget");
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "budget", stage: "review" });
  });

  test("past the daily Budget no Job starts a new Stage run, and a running one finishes", async () => {
    let releaseSecond!: () => void;
    const secondMayFinish = new Promise<void>((r) => (releaseSecond = r));
    const f = fakeFactory(
      new ScriptedAgent({
        triage: [
          // Job 7's triage alone passes the $0.35 daily Budget…
          async (): Promise<AgentRunOutcome> => {
            setTimeout(releaseSecond, 20);
            return pass("Expensive triage.", { cost_usd: 0.4 });
          },
          // …while Job 8's triage is still running. It finishes and is recorded.
          async (): Promise<AgentRunOutcome> => {
            await secondMayFinish;
            return pass("Triaged while over.");
          },
        ],
      }),
      withBudgets("{ daily: { usd: 0.35 } }"),
    );
    f.source.push(approved(7), approved(8));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "triage"]);
    const events = f.log.store.read();
    expect(events.filter((e) => e.type === "stage-passed")).toHaveLength(2);
    // Nothing started once the day's spend had reached the Budget.
    let spent = 0;
    for (const e of events) {
      if (e.type === "stage-started") expect(spent).toBeLessThan(0.35);
      if (typeof e.data.cost_usd === "number") spent += e.data.cost_usd;
    }
    const exceeded = events.filter((e) => e.type === "budget-exceeded");
    expect(exceeded.map((e) => e.data.budget)).toEqual(["daily", "daily"]);
    expect(f.log.jobs().map((j) => [j.issue, j.status, j.reason])).toEqual([
      [7, "paused", "budget"],
      [8, "paused", "budget"],
    ]);
  });

  test("a hard Stage-run Budget hit ends the run and pauses the Job instead of asking about a Run error", async () => {
    const hit: AgentRunOutcome = { kind: "error", reason: "budget", message: "maxBudgetUsd reached", facts: facts({ cost_usd: 5 }) };
    const f = fakeFactory(new ScriptedAgent({ build: [hit] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.types(f.onlyJob().job_id).slice(-3)).toEqual(["stage-started", "stage-errored", "budget-exceeded"]);
    expect(f.log.store.read().at(-1)).toMatchObject({
      type: "budget-exceeded",
      data: { budget: "stage_run", checkpoint: "after-stage-result", spent_usd: 5, limit_usd: 5 },
    });
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "budget", stage: "build" });
  });

  test("a Stage run measured over its hard Budget pauses the Job after its result is recorded", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [pass("Long triage.", { turns: 150 })] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage"]);
    expect(f.types(f.onlyJob().job_id).slice(-2)).toEqual(["stage-passed", "budget-exceeded"]);
    expect(f.log.store.read().at(-1)?.data.why).toBe("the Stage run used 150 turns, over its 100-turn Budget");
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "budget" });
  });
});
