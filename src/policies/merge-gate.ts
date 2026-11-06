import picomatch from "picomatch";
import type { Autonomy } from "../config/types.js";
import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { ChangedFile, RiskMatch } from "./risk.js";

/** How a Stage's latest Stage run in this Attempt ended, and the head it ended at. */
export interface StageAtGate {
  stage: string;
  ending: "passed" | "skipped" | "failed" | "needs-human" | "errored" | "none";
  /** The Job branch's head when the Stage run ended, as the Orchestrator measured it. */
  head: string | null;
}

/** The PR's state on GitHub, or null when there is no PR yet. */
export type PrState = { checks: "green" | "pending" | "red" | "none"; conflicts: boolean } | null;

/** Everything the fixed Merge gate core is decided from (ADR 0004). */
export interface MergeGateFacts {
  /** The PR's head commit. */
  head: string;
  /** Every Stage of the Pipeline, in order. */
  stages: StageAtGate[];
  /** Evidence the Orchestrator recorded in this Attempt. */
  evidence: { head: string; stage?: string }[];
  pr: PrState;
  /** Why the PR edits its own checks, from `selfEditedChecks`. */
  selfEdits: string[];
}

export type GateFailureCode = "stages" | "evidence" | "no-pr" | "checks-red" | "checks-pending" | "checks-none" | "conflicts" | "self-edit";

export interface MergeGateResult {
  passed: boolean;
  failures: { code: GateFailureCode; why: string }[];
}

/**
 * The fixed Merge gate core: every Stage passed at the head commit, Evidence for that
 * exact commit, green checks, no conflicts, and no edits to the PR's own checks.
 * Nothing in config or a Reply command changes it (ADR 0003, ADR 0004).
 */
export function evaluateMergeGate(facts: MergeGateFacts): MergeGateResult {
  const failures: MergeGateResult["failures"] = [];
  const fail = (code: GateFailureCode, why: string) => failures.push({ code, why });

  for (const s of facts.stages) {
    if (s.ending !== "passed" && s.ending !== "skipped") fail("stages", `${s.stage} hasn't passed (latest: ${s.ending})`);
  }
  // Stages before the one that wrote the head judged earlier commits, as they should (triage
  // judges the issue); every Stage from the first that saw the head on must have passed it (ADR 0004).
  const passedStages = facts.stages.filter((s) => s.ending === "passed");
  const firstAtHead = passedStages.findIndex((s) => s.head === facts.head);
  if (firstAtHead === -1) fail("stages", `no Stage passed at the head ${facts.head}`);
  else {
    for (const s of passedStages.slice(firstAtHead)) {
      if (s.head !== facts.head) fail("stages", `${s.stage} passed at ${s.head}, not the head ${facts.head}`);
    }
  }

  if (!facts.evidence.some((e) => e.head === facts.head)) fail("evidence", `no Evidence for the head ${facts.head}`);

  if (!facts.pr) fail("no-pr", "there is no PR");
  else {
    const checks = CHECKS_FAILURE[facts.pr.checks];
    if (checks) fail(...checks);
    if (facts.pr.conflicts) fail("conflicts", "the PR conflicts with its base");
  }

  if (facts.selfEdits.length) fail("self-edit", `the PR edits its own checks: ${facts.selfEdits.join("; ")}`);
  return { passed: !failures.length, failures };
}

const CHECKS_FAILURE: Record<NonNullable<PrState>["checks"], [GateFailureCode, string] | null> = {
  green: null,
  red: ["checks-red", "the PR's checks are red"],
  pending: ["checks-pending", "the PR's checks are still running"],
  none: ["checks-none", "the PR has no checks"],
};

export interface SelfEditInput {
  files: ChangedFile[];
  /** Every verify command the Target repo's Check Stages run. */
  commands: string[];
  /** Each changed `package.json`, before and after; null where it doesn't exist. */
  packageJson: { path: string; before: string | null; after: string | null }[];
}

const CI_WORKFLOWS = picomatch([".github/workflows/**", ".github/actions/**"], { dot: true });
const FACTORY_CONFIG = picomatch(["**/factory.yaml", "**/.factory/**"], { dot: true });
const MAKEFILES = new Set(["Makefile", "makefile", "GNUmakefile"]);
/** What `scriptsOf` gives for a `package.json` that won't parse. */
const UNREADABLE = "\0unreadable";

/**
 * Why a change edits its own checks: CI workflows, Factory config, `package.json`
 * scripts, or a file a verify command runs. Such a change makes its Evidence untrusted.
 */
export function selfEditedChecks({ files, commands, packageJson }: SelfEditInput): string[] {
  const reasons: string[] = [];
  for (const { path } of files) {
    const runBy = commands.find((c) => runs(c, path));
    if (CI_WORKFLOWS(path)) reasons.push(`${path} is a CI workflow`);
    else if (FACTORY_CONFIG(path)) reasons.push(`${path} is Factory config`);
    else if (path === "package.json" || path.endsWith("/package.json")) {
      const contents = packageJson.find((p) => p.path === path);
      // Fail closed: contents we weren't given, or can't read, count as changed scripts.
      if (!contents || scriptsOf(contents.before) !== scriptsOf(contents.after) || scriptsOf(contents.after) === UNREADABLE) {
        reasons.push(`${path} changes its scripts`);
      }
    } else if (runBy) reasons.push(`${path} is run by \`${runBy}\``);
  }
  return reasons;
}

/** Does `command` run the repo file at `path`, directly or through make? */
function runs(command: string, path: string): boolean {
  const words = command.split(/[\s;&|()]+/).map((w) => w.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""));
  if (words.includes(path)) return true;
  return MAKEFILES.has(path) && words.includes("make");
}

/** A `package.json`'s scripts, in a form two versions can be compared by. */
function scriptsOf(text: string | null): string {
  if (text === null) return "{}";
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return JSON.stringify(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    return UNREADABLE;
  }
}

export interface MergeInput {
  autonomy: Autonomy;
  gate: MergeGateResult;
  risks: RiskMatch[];
  /** A human sent `/approve` for this Job. It overrides Risk rules and Autonomy, never the gate core. */
  approved: boolean;
}

/** Why the Merge gate checkpoint asks a human: an `/approve` of one of these is an approval to merge. */
export const ASK_CAUSES = ["self-edited-checks", "merge-gate", "risk-rule", "autonomy"] as const;
export type AskCause = (typeof ASK_CAUSES)[number];

/**
 * Whether a human `/approve`d merging this Attempt's work: an approve answering a Merge gate
 * request, with nothing pushed since. It feeds `decideMerge`, which never lets it past the gate core.
 */
export function approvedAtMergeGate(events: FactoryEvent[]): boolean {
  const lastPush = events.findLast((e) => e.type === "branch-pushed")?.seq ?? 0;
  return events.some((e) => {
    if (e.type !== "human-answered" || e.data.command !== "approve" || e.seq < lastPush) return false;
    const request = events.find((r) => r.id === e.data.request);
    return (ASK_CAUSES as readonly unknown[]).includes(request?.data.cause);
  });
}

export type MergeDecision = (
  | { action: "merge"; why: string }
  /** The PR's checks are still running: decide again when they finish. */
  | { action: "wait"; why: string }
  /** The Job goes to waiting (approval). */
  | { action: "ask"; cause: AskCause; why: string }
) & {
  /** In trial: what the Factory would have done, and why (`would-have-merged`). */
  wouldHaveMerged?: { would: boolean; why: string };
};

/** What happens at the Merge gate, given the Autonomy level, the gate core, Risk rules and any `/approve`. */
export function decideMerge({ autonomy, gate, risks, approved }: MergeInput): MergeDecision {
  const why = (fs: { why: string }[]) => fs.map((f) => f.why).join("; ");
  const selfEdit = gate.failures.filter((f) => f.code === "self-edit");
  const blocking = gate.failures.filter((f) => f.code !== "checks-pending");
  /** An ask; in trial it also carries what the Factory would have done, by default for the same reason. */
  const ask = (cause: AskCause, because: string, would = false, wouldBecause = because): MergeDecision =>
    autonomy === "trial" ? { action: "ask", cause, why: because, wouldHaveMerged: { would, why: wouldBecause } } : { action: "ask", cause, why: because };

  if (selfEdit.length) return ask("self-edited-checks", why(selfEdit));
  if (blocking.length) return ask("merge-gate", why(blocking));
  if (!gate.passed) return { action: "wait", why: why(gate.failures) };

  if (approved) return { action: "merge", why: "a human approved it and the Merge gate passed" };
  if (risks.length) {
    const because = risks.map((r) => `Risk rule ${r.rule}: ${r.why}`).join("; ");
    return ask("risk-rule", because);
  }
  if (autonomy === "auto") return { action: "merge", why: "Autonomy is auto, the Merge gate passed and no Risk rule matched" };
  return ask("autonomy", `Autonomy is ${autonomy}: you merge, or \`/approve\` and the Factory merges`, true, "the Merge gate passed and no Risk rule matched");
}

/**
 * What the Merge gate checkpoint records, in order: `merge-gate-evaluated`, in trial
 * `would-have-merged`, then `checkpoint-evaluated` with what it decided.
 */
export function mergeGateEvents(head: string, gate: MergeGateResult, decision: MergeDecision): Required<Pick<NewEvent, "type" | "data">>[] {
  return [
    { type: "merge-gate-evaluated", data: { passed: gate.passed, head, failures: gate.failures } },
    ...(decision.wouldHaveMerged ? [{ type: "would-have-merged", data: { ...decision.wouldHaveMerged } }] : []),
    { type: "checkpoint-evaluated", data: { checkpoint: "merge-gate", outcome: decision.action, why: decision.why } },
  ];
}
