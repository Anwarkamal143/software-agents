import type { Budgets } from "../config/types.js";
import type { FactoryEvent } from "../events/envelope.js";

/** A Budget a Job has passed. It sends the Job to paused (budget). Dollars are always estimates. */
export interface BudgetHit {
  budget: "stage_run" | "job" | "daily";
  spent_usd: number;
  limit_usd: number;
  why: string;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The soft Budgets, checked before each Stage run: once a Job, or the whole Factory
 * today, has spent its Budget, no new Stage run starts. Running ones finish (ADR 0004).
 */
export function budgetBeforeStageRun({ budgets, jobSpent, daySpent }: { budgets: Budgets; jobSpent: number; daySpent: number }): BudgetHit | null {
  if (jobSpent >= budgets.job.usd) {
    return { budget: "job", spent_usd: jobSpent, limit_usd: budgets.job.usd, why: `this Job has spent an estimated ${usd(jobSpent)} of its ${usd(budgets.job.usd)} Budget` };
  }
  if (daySpent >= budgets.daily.usd) {
    return {
      budget: "daily",
      spent_usd: daySpent,
      limit_usd: budgets.daily.usd,
      why: `the Factory has spent an estimated ${usd(daySpent)} of its ${usd(budgets.daily.usd)} daily Budget`,
    };
  }
  return null;
}

export interface StageRunUsage {
  cost_usd?: number;
  turns?: number;
  duration_ms?: number;
}

/**
 * The hard per-Stage-run Budget, checked after a Stage result: a Run error the adapter
 * put down to the Budget, or a run the Orchestrator measured over any of its limits.
 */
export function budgetAfterStageRun({ budget, facts, errorReason }: { budget: Budgets["stage_run"]; facts: StageRunUsage; errorReason?: string }): BudgetHit | null {
  const spent = facts.cost_usd ?? 0;
  const hit = (why: string): BudgetHit => ({ budget: "stage_run", spent_usd: spent, limit_usd: budget.usd, why: `the Stage run used ${why}` });
  if (spent > budget.usd) return hit(`an estimated ${usd(spent)}, over its ${usd(budget.usd)} Budget`);
  if ((facts.turns ?? 0) > budget.turns) return hit(`${facts.turns} turns, over its ${budget.turns}-turn Budget`);
  const minutes = (facts.duration_ms ?? 0) / 60_000;
  if (minutes > budget.minutes) return hit(`${Math.round(minutes)} minutes, over its ${budget.minutes}-minute Budget`);
  if (errorReason === "budget") return hit("up its Budget");
  return null;
}

/** Estimated dollars spent on events at or after `since`, across every Job. */
export function spentSince(events: Iterable<Pick<FactoryEvent, "at" | "data">>, since: string): number {
  const from = Date.parse(since);
  let total = 0;
  for (const e of events) {
    if (typeof e.data.cost_usd === "number" && Date.parse(e.at) >= from) total += e.data.cost_usd;
  }
  return total;
}
