import { describe, expect, test } from "vitest";
import type { Autonomy } from "../src/config/types.js";
import { EventTypes } from "../src/events/registry.js";
import { decideMerge, evaluateMergeGate, mergeGateEvents, selfEditedChecks, type MergeGateFacts, type StageAtGate } from "../src/policies/merge-gate.js";
import { BUILT_IN_RISK_RULES } from "../src/config/policies.js";
import { matchRiskRules, type ChangedFile } from "../src/policies/risk.js";

const H = "c0ffee";
const passed = (stage: string, head: string | null = H): StageAtGate => ({ stage, ending: "passed", head });

/** A Job that should pass the gate: triage judged the base, build wrote H, everything after saw H. */
const good = (over: Partial<MergeGateFacts> = {}): MergeGateFacts => ({
  head: H,
  stages: [passed("triage", "base"), passed("build"), passed("verify"), passed("review"), passed("security")],
  evidence: [{ head: H, stage: "verify" }],
  pr: { checks: "green", conflicts: false },
  selfEdits: [],
  ...over,
});

const file = (path: string): ChangedFile => ({ path, added: 1, removed: 0, addedLines: ["x"] });
const codes = (facts: MergeGateFacts) => evaluateMergeGate(facts).failures.map((f) => f.code);

describe("evaluateMergeGate: the fixed core", () => {
  test("a Job with every Stage passed at the head, Evidence for it and green checks passes", () => {
    expect(evaluateMergeGate(good())).toEqual({ passed: true, failures: [] });
  });

  test("a skipped Stage counts as passed", () => {
    expect(codes(good({ stages: [...good().stages, { stage: "ui-review", ending: "skipped", head: null }] }))).toEqual([]);
  });

  test.each(["failed", "needs-human", "errored", "none"] as const)("a Stage whose latest ending is %s fails the gate", (ending) => {
    const facts = good({ stages: [passed("triage", "base"), passed("build"), { stage: "verify", ending, head: H }, passed("review")] });
    expect(evaluateMergeGate(facts).failures).toEqual([{ code: "stages", why: `verify hasn't passed (latest: ${ending})` }]);
  });

  test("a Stage after the head was written that passed an older commit fails the gate", () => {
    const facts = good({ stages: [passed("triage", "base"), passed("build"), passed("verify"), passed("review", "old"), passed("security")] });
    expect(evaluateMergeGate(facts).failures).toEqual([{ code: "stages", why: "review passed at old, not the head c0ffee" }]);
  });

  test("a head that no Stage saw, such as a push from outside, fails the gate", () => {
    expect(codes(good({ head: "pushed-by-someone" }))).toEqual(["stages", "evidence"]);
  });

  test("Evidence for another commit doesn't count", () => {
    expect(evaluateMergeGate(good({ evidence: [{ head: "old", stage: "verify" }] })).failures).toEqual([
      { code: "evidence", why: "no Evidence for the head c0ffee" },
    ]);
  });

  test("a Pipeline with no Check Stage never has Evidence, so never passes", () => {
    expect(codes(good({ evidence: [] }))).toEqual(["evidence"]);
  });

  test.each([
    [null, "no-pr"],
    [{ checks: "red", conflicts: false }, "checks-red"],
    [{ checks: "pending", conflicts: false }, "checks-pending"],
    [{ checks: "none", conflicts: false }, "checks-none"],
    [{ checks: "green", conflicts: true }, "conflicts"],
  ] as const)("PR state %j fails with %s", (pr, code) => {
    expect(codes(good({ pr }))).toEqual([code]);
  });

  test("a PR editing its own checks fails the gate", () => {
    expect(evaluateMergeGate(good({ selfEdits: [".github/workflows/ci.yml is a CI workflow"] })).failures).toEqual([
      { code: "self-edit", why: "the PR edits its own checks: .github/workflows/ci.yml is a CI workflow" },
    ]);
  });
});

describe("selfEditedChecks", () => {
  const edits = (paths: string[], commands: string[] = ["npm test"], packageJson: { path: string; before: string | null; after: string | null }[] = []) =>
    selfEditedChecks({ files: paths.map(file), commands, packageJson });

  test("an ordinary change edits no checks", () => {
    expect(edits(["src/app.ts", "test/app.test.ts", "README.md"])).toEqual([]);
  });

  test.each([".github/workflows/ci.yml", ".github/actions/setup/action.yml"])("%s is a CI workflow", (path) => {
    expect(edits([path])).toEqual([`${path} is a CI workflow`]);
  });

  test.each(["factory.yaml", ".factory/factory.yaml"])("%s is Factory config", (path) => {
    expect(edits([path])).toEqual([`${path} is Factory config`]);
  });

  test("a file a verify command runs is an edit to the checks", () => {
    expect(edits(["scripts/verify.sh"], ["./scripts/verify.sh --all"])).toEqual(["scripts/verify.sh is run by `./scripts/verify.sh --all`"]);
    expect(edits(["scripts/verify.sh"], ["bash scripts/verify.sh"])).toEqual(["scripts/verify.sh is run by `bash scripts/verify.sh`"]);
  });

  test("a Makefile is an edit to the checks when a verify command runs make", () => {
    expect(edits(["Makefile"], ["make test"])).toEqual(["Makefile is run by `make test`"]);
    expect(edits(["Makefile"], ["npm test"])).toEqual([]);
  });

  test("changed package.json scripts are an edit to the checks", () => {
    const before = JSON.stringify({ name: "a", scripts: { test: "vitest run" } });
    const after = JSON.stringify({ name: "a", scripts: { test: "true" } });
    expect(edits(["package.json"], ["npm test"], [{ path: "package.json", before, after }])).toEqual(["package.json changes its scripts"]);
  });

  test("a package.json change outside scripts is not", () => {
    const before = JSON.stringify({ name: "a", version: "1.0.0", scripts: { test: "vitest run" } });
    const after = JSON.stringify({ name: "a", version: "1.1.0", scripts: { test: "vitest run" } });
    expect(edits(["package.json"], ["npm test"], [{ path: "package.json", before, after }])).toEqual([]);
  });

  test("a package.json that won't parse, or whose contents weren't given, counts as an edit", () => {
    expect(edits(["package.json"], ["npm test"], [{ path: "package.json", before: "{}", after: "{ nope" }])).toEqual(["package.json changes its scripts"]);
    expect(edits(["web/package.json"])).toEqual(["web/package.json changes its scripts"]);
  });

  test("a new package.json with scripts is an edit; a deleted one is too", () => {
    expect(edits(["web/package.json"], ["npm test"], [{ path: "web/package.json", before: null, after: '{"scripts":{"test":"true"}}' }])).toHaveLength(1);
    expect(edits(["package.json"], ["npm test"], [{ path: "package.json", before: '{"scripts":{"test":"x"}}', after: null }])).toHaveLength(1);
  });
});

describe("decideMerge: Autonomy level × gate outcome", () => {
  const gate = {
    passes: evaluateMergeGate(good()),
    fails: evaluateMergeGate(good({ evidence: [] })),
    "self-edit": evaluateMergeGate(good({ selfEdits: ["package.json changes its scripts"] })),
    pending: evaluateMergeGate(good({ pr: { checks: "pending", conflicts: false } })),
  };
  type Outcome = keyof typeof gate;
  const risk = [{ rule: "auth", why: "src/auth/a.ts matches **/auth/**" }];

  // [autonomy, gate, Risk rule matched, /approve, action, cause, would-have-merged]
  const table: [Autonomy, Outcome, boolean, boolean, string, string | undefined, boolean | undefined][] = [
    ["off", "passes", false, false, "ask", "autonomy", undefined],
    ["off", "fails", false, false, "ask", "merge-gate", undefined],
    ["off", "self-edit", false, false, "ask", "self-edited-checks", undefined],
    ["off", "pending", false, false, "wait", undefined, undefined],
    ["off", "passes", true, false, "ask", "risk-rule", undefined],
    ["off", "passes", false, true, "merge", undefined, undefined],
    ["off", "fails", false, true, "ask", "merge-gate", undefined],
    ["off", "self-edit", false, true, "ask", "self-edited-checks", undefined],

    ["trial", "passes", false, false, "ask", "autonomy", true],
    ["trial", "fails", false, false, "ask", "merge-gate", false],
    ["trial", "self-edit", false, false, "ask", "self-edited-checks", false],
    ["trial", "pending", false, false, "wait", undefined, undefined],
    ["trial", "passes", true, false, "ask", "risk-rule", false],
    ["trial", "passes", false, true, "merge", undefined, undefined],
    ["trial", "fails", false, true, "ask", "merge-gate", false],
    ["trial", "self-edit", false, true, "ask", "self-edited-checks", false],

    ["auto", "passes", false, false, "merge", undefined, undefined],
    ["auto", "fails", false, false, "ask", "merge-gate", undefined],
    ["auto", "self-edit", false, false, "ask", "self-edited-checks", undefined],
    ["auto", "pending", false, false, "wait", undefined, undefined],
    ["auto", "passes", true, false, "ask", "risk-rule", undefined],
    ["auto", "passes", true, true, "merge", undefined, undefined],
    ["auto", "fails", false, true, "ask", "merge-gate", undefined],
    ["auto", "self-edit", false, true, "ask", "self-edited-checks", undefined],
  ];

  test.each(table)("%s, gate %s, risk %s, approved %s → %s %s (would merge: %s)", (autonomy, outcome, risky, approved, action, cause, would) => {
    const d = decideMerge({ autonomy, gate: gate[outcome], risks: risky ? risk : [], approved });
    expect(d.action).toBe(action);
    expect(d.action === "ask" ? d.cause : undefined).toBe(cause);
    expect(d.wouldHaveMerged?.would).toBe(would);
  });

  test("trial says why it would not merge", () => {
    expect(decideMerge({ autonomy: "trial", gate: gate.passes, risks: risk, approved: false }).wouldHaveMerged).toEqual({
      would: false,
      why: "Risk rule auth: src/auth/a.ts matches **/auth/**",
    });
    expect(decideMerge({ autonomy: "trial", gate: gate.fails, risks: [], approved: false }).wouldHaveMerged).toEqual({
      would: false,
      why: "no Evidence for the head c0ffee",
    });
    expect(decideMerge({ autonomy: "trial", gate: gate.passes, risks: [], approved: false }).wouldHaveMerged).toEqual({
      would: true,
      why: "the Merge gate passed and no Risk rule matched",
    });
  });

  test("a PR editing its own checks never merges, at any Autonomy level, even with /approve", () => {
    for (const autonomy of ["off", "trial", "auto"] as const) {
      for (const approved of [false, true]) {
        expect(decideMerge({ autonomy, gate: gate["self-edit"], risks: [], approved }).action).not.toBe("merge");
      }
    }
  });

  test.each([
    ["auth", file("src/auth/session.ts")],
    ["payments", file("app/billing/invoice.ts")],
    ["migrations", file("db/migrations/0042.sql")],
    ["secrets", file(".env.local")],
    ["ci-config", file(".github/workflows/deploy.yml")],
    ["size-cap", { path: "src/big.ts", added: 401, removed: 0, addedLines: [] }],
  ])("Risk rule %s sends a Job to waiting (approval) in auto", (rule, changed) => {
    const risks = matchRiskRules(BUILT_IN_RISK_RULES, { labels: [], files: [changed], sizeCap: 400 });
    const d = decideMerge({ autonomy: "auto", gate: gate.passes, risks, approved: false });
    expect(d).toMatchObject({ action: "ask", cause: "risk-rule" });
    expect(d.action === "ask" && d.why).toMatch(new RegExp(`^Risk rule ${rule}: `));
  });
});

describe("mergeGateEvents", () => {
  const types = new EventTypes();
  const recordable = (events: { type: string; data: Record<string, unknown> }[]) => {
    for (const e of events) types.check(e.type, e.data);
    return events;
  };

  test("trial records the gate, what it would have done, and the checkpoint's outcome", () => {
    const gate = evaluateMergeGate(good());
    const decision = decideMerge({ autonomy: "trial", gate, risks: [], approved: false });
    expect(recordable(mergeGateEvents(H, gate, decision))).toEqual([
      { type: "merge-gate-evaluated", data: { passed: true, head: H, failures: [] } },
      { type: "would-have-merged", data: { would: true, why: "the Merge gate passed and no Risk rule matched" } },
      { type: "checkpoint-evaluated", data: { checkpoint: "merge-gate", outcome: "ask", why: "Autonomy is trial: you merge" } },
    ]);
  });

  test("auto with a failing gate records the failures and no would-have-merged", () => {
    const gate = evaluateMergeGate(good({ evidence: [] }));
    const decision = decideMerge({ autonomy: "auto", gate, risks: [], approved: false });
    expect(recordable(mergeGateEvents(H, gate, decision))).toEqual([
      { type: "merge-gate-evaluated", data: { passed: false, head: H, failures: [{ code: "evidence", why: "no Evidence for the head c0ffee" }] } },
      { type: "checkpoint-evaluated", data: { checkpoint: "merge-gate", outcome: "ask", why: "no Evidence for the head c0ffee" } },
    ]);
  });
});
