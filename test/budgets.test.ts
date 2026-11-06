import { describe, expect, test } from "vitest";
import { BUILT_IN_POLICIES } from "../src/config/policies.js";
import { budgetBeforeStageRun, budgetAfterStageRun, spentSince, spentToday } from "../src/policies/budgets.js";

const budgets = BUILT_IN_POLICIES.budgets; // $5 / 100 turns / 30 min per Stage run, $20 per Job, $50 per day

describe("budgetBeforeStageRun", () => {
  test("under both soft Budgets, the Stage run may start", () => {
    expect(budgetBeforeStageRun({ budgets, jobSpent: 19.99, daySpent: 49.99 })).toBeNull();
  });

  test("a Job that has spent its Budget starts no new Stage run", () => {
    expect(budgetBeforeStageRun({ budgets, jobSpent: 20, daySpent: 3 })).toEqual({
      budget: "job",
      spent_usd: 20,
      limit_usd: 20,
      why: "this Job has spent an estimated $20.00 of its $20.00 Budget",
    });
  });

  test("past the daily Budget, no Job starts a new Stage run", () => {
    expect(budgetBeforeStageRun({ budgets, jobSpent: 0, daySpent: 50.4 })).toEqual({
      budget: "daily",
      spent_usd: 50.4,
      limit_usd: 50,
      why: "the Factory has spent an estimated $50.40 of its $50.00 daily Budget",
    });
  });

  test("the Job Budget is reported first when both are passed", () => {
    expect(budgetBeforeStageRun({ budgets, jobSpent: 21, daySpent: 60 })?.budget).toBe("job");
  });
});

describe("budgetAfterStageRun", () => {
  const facts = { cost_usd: 1, turns: 10, duration_ms: 60_000 };

  test("a Stage run inside its hard Budget is fine", () => {
    expect(budgetAfterStageRun({ budget: budgets.stage_run, facts })).toBeNull();
  });

  test("a Run error the adapter put down to the Budget is a hard hit", () => {
    expect(budgetAfterStageRun({ budget: budgets.stage_run, facts, errorReason: "budget" })).toMatchObject({ budget: "stage_run", limit_usd: 5 });
  });

  test.each([
    [{ cost_usd: 5.2 }, "an estimated $5.20, over its $5.00 Budget"],
    [{ turns: 101 }, "101 turns, over its 100-turn Budget"],
    [{ duration_ms: 31 * 60_000 }, "31 minutes, over its 30-minute Budget"],
  ])("a run that measured over its limit (%j) is a hard hit", (over, why) => {
    expect(budgetAfterStageRun({ budget: budgets.stage_run, facts: { ...facts, ...over } })?.why).toBe(`the Stage run used ${why}`);
  });

  test("other Run errors are not Budget hits", () => {
    expect(budgetAfterStageRun({ budget: budgets.stage_run, facts, errorReason: "timeout" })).toBeNull();
  });
});

describe("spentSince", () => {
  test("adds the estimated cost of every event at or after the start of the day, across Jobs", () => {
    const events = [
      { at: "2026-11-05T23:59:59.000Z", data: { stage: "build", cost_usd: 9 } },
      { at: "2026-11-06T00:00:00.000Z", data: { stage: "review", cost_usd: 1.25 } },
      { at: "2026-11-06T08:00:00.000Z", data: { stage: "build", reason: "crash", cost_usd: 2 } },
      { at: "2026-11-06T08:00:01.000Z", data: { branch: "x", before: "a", head: "b" } },
    ];
    expect(spentSince(events, "2026-11-06T00:00:00.000Z")).toBe(3.25);
  });
});

describe("spentToday", () => {
  test("counts from local midnight", () => {
    const now = new Date(2026, 10, 6, 15, 0);
    const events = [
      { at: new Date(2026, 10, 5, 23, 59).toISOString(), data: { cost_usd: 9 } },
      { at: new Date(2026, 10, 6, 0, 1).toISOString(), data: { cost_usd: 1.5 } },
    ];
    expect(spentToday(events, now)).toBe(1.5);
  });
});
