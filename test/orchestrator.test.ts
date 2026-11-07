import { describe, expect, test } from "vitest";
import type { AgentRunOutcome } from "../src/agents/adapter.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approved } from "./fakes/source.js";
import { building, fail, finding, pass, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory, expectAtMergeGate } from "./helpers/factory.js";
import { fixture } from "./helpers/config.js";
import { agentGit } from "./helpers/git.js";

describe("Orchestrator: one Job end to end", () => {
  test("a Job runs triage → build → verify → review → security and reaches the Merge gate checkpoint", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [building],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const job = f.onlyJob();
    expect(f.types(job.job_id)).toEqual([
      "job-approved",
      "attempt-started",
      "stage-started", "stage-passed", // triage
      "stage-started", "branch-pushed", "pr-opened", "stage-passed", // build
      "stage-started", "evidence-recorded", "stage-passed", // verify
      "stage-started", "stage-passed", // review
      "stage-started", "stage-passed", // security
      "merge-gate-evaluated", "would-have-merged", "checkpoint-evaluated", "human-requested",
    ]);
    expect(f.agent.stagesRun()).toEqual(["triage", "build", "review", "security"]);
    expect(job).toMatchObject({ repo: "acme/web-app", issue: 7, status: "waiting", stage: "security", attempt: 1 });

    const events = f.log.store.read();
    expectAtMergeGate(events, { actor: "orchestrator" });
    expect(events.find((e) => e.type === "attempt-started")?.data).toEqual({ branch: "factory/7", base: agentGit(f.remote, "rev-parse", "main") });

    // Every write reached the Mirror, in order, with the Job state after it.
    expect(f.mirror.writes.map((w) => w.event.id)).toEqual(events.map((e) => e.id));
    expect(f.mirror.summary().slice(0, 4)).toEqual([
      ["job-approved", "queued", null],
      ["attempt-started", "queued", null],
      ["stage-started", "running", "triage"],
      ["stage-passed", "queued", "triage"],
    ]);
  });

  test("a review fail Bounces to build, with the findings in build's next brief", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [building, building],
        review: [fail("Missing test.", [finding("missing-test:health", "No test covers /health.")])],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "review", "build", "review", "security"]);
    const bounced = f.log.store.read().find((e) => e.type === "bounced");
    expect(bounced?.data).toEqual({ from: "review", to: "build", bounce: 1 });
    expect(f.log.store.read().find((e) => e.id === bounced?.caused_by)?.type).toBe("stage-failed");

    const secondBuild = f.agent.requests[3]!;
    expect(secondBuild.brief).toMatchObject({ stage: "build", bounce: 1, attempt: 1, branch: "factory/7" });
    expect(secondBuild.brief.earlier.at(-1)).toEqual({
      stage: "review",
      verdict: "fail",
      summary: "Missing test.",
      findings: [{ severity: "error", file: "src/app.ts", message: "No test covers /health.", root_cause: "missing-test:health" }],
    });
    expect(secondBuild.renderedBrief).toContain("No test covers /health. (root cause: missing-test:health)");
    expect(f.onlyJob()).toMatchObject({ status: "waiting", stage: "security" });
  });

  test("with bounce_cap 3, three Bounces happen and the fourth fail sends the Job to waiting", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: Array.from({ length: 4 }, () => building),
        review: [1, 2, 3, 4].map((n) => fail(`Round ${n}.`, [finding(`problem-${n}`)])),
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    expect(events.filter((e) => e.type === "bounced").map((e) => e.data.bounce)).toEqual([1, 2, 3]);
    expect(f.agent.stagesRun().filter((s) => s === "review")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      type: "human-requested",
      data: { kind: "approval", cause: "bounce-cap", text: "review failed after 3 Bounces (cap 3). Round 4." },
    });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", stage: "review", reason: "bounce-cap" });
  });

  test("the same root-cause key twice stops Bouncing early", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [building, building],
        review: [fail("Missing test.", [finding("missing-test:health")]), fail("Still missing.", [finding("missing-test:health")])],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "bounced")).toHaveLength(1);
    expect(f.log.store.read().at(-1)).toMatchObject({
      type: "human-requested",
      data: { kind: "approval", cause: "repeated-root-cause", text: "review failed again for the same root cause: missing-test:health." },
    });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "repeated-root-cause" });
  });

  test("a failing Check Stage Bounces to its on_fail Stage with the failing command as the finding", async () => {
    // The first build forgets to write built.txt, so verify fails; the second gets it right.
    const f = fakeFactory(new ScriptedAgent({ build: [pass("Built, honest."), building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const failed = f.log.store.read().find((e) => e.type === "stage-failed")!;
    expect(failed).toMatchObject({ actor: "stage:verify", data: { stage: "verify", summary: '`test -f "$PWD/built.txt"` exited 1.' } });
    expect((failed.data.output as { size: number }).size).toBeGreaterThan(0);
    expect(f.agent.requests[2]!.brief.earlier.at(-1)).toMatchObject({ stage: "verify", verdict: "fail" });
    expectAtMergeGate(f.log.store.read());
  });

  test("a when condition skips a Stage, and the skip is recorded", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }));
    f.source.push(approved(7, ["pipeline:ui"]));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "review"]);
    expect(f.log.store.read().find((e) => e.type === "stage-skipped")).toMatchObject({
      actor: "orchestrator",
      data: { stage: "ui-review", why: "when: no label in [ui] and no changed file matches [src/ui/**]" },
    });
    expect(f.agent.requests[2]!.brief.earlier.map((r) => [r.stage, r.verdict])).toEqual([
      ["triage", "pass"],
      ["build", "pass"],
      ["verify", "pass"],
      ["ui-review", "skipped"],
    ]);
  });

  test("a when condition runs the Stage when the Attempt changed a matching path", async () => {
    const f = fakeFactory(
      new ScriptedAgent({ build: [(req) => building(req, { "src/ui/Button.tsx": "export const Button = 1;\n" })] }),
    );
    f.source.push(approved(7, ["pipeline:ui"]));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "ui-review", "review"]);
  });

  test("a Stage result that doesn't match the schema is not accepted as a Verdict", async () => {
    const notAResult: AgentRunOutcome = { kind: "output", output: { verdict: "pass", summary: "LGTM", confidence: 0.99 }, facts: { cost_usd: 0.2, tokens: 10, turns: 1, duration_ms: 5, head: null, files_changed: [] } };
    const f = fakeFactory(
      new ScriptedAgent({ triage: [notAResult, notAResult] }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    expect(events.some((e) => e.type === "stage-passed")).toBe(false);
    expect(events.find((e) => e.type === "stage-errored")).toMatchObject({
      actor: "stage:triage",
      data: {
        stage: "triage",
        reason: "invalid-result",
        message: "result must have required property 'findings'; result must have required property 'artifacts'; result has an unexpected field \"confidence\"",
        cost_usd: 0.2,
      },
    });
    // Retried with a correction turn; the same schema errors again go to a human.
    expect(f.agent.stagesRun()).toEqual(["triage", "triage"]);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "repeated-run-error", cost_usd: 0.4 });
  });

  test("a needs-human Verdict sends the Job to waiting with the Stage's question", async () => {
    const question = { text: "REST or GraphQL?", options: ["REST", "GraphQL"] };
    const f = fakeFactory(
      new ScriptedAgent({ triage: [{ kind: "output", output: { verdict: "needs-human", summary: "Ambiguous.", findings: [], artifacts: [], question }, facts: { cost_usd: 0, tokens: 0, turns: 1, duration_ms: 1, head: null, files_changed: [] } }] }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().slice(-2).map((e) => [e.type, e.data.question ?? e.data.text, e.data.options])).toEqual([
      ["stage-needs-human", "REST or GraphQL?", ["REST", "GraphQL"]],
      ["human-requested", "REST or GraphQL?", ["REST", "GraphQL"]],
    ]);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", stage: "triage", reason: "question" });
  });

  test("every transition in the run names its cause: the event that triggered it", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [building, building],
        review: [fail("Missing test.", [finding("missing-test")])],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const byId = new Map(events.map((e) => [e.id, e]));
    const causes = events.map((e) => [e.type, e.caused_by ? byId.get(e.caused_by)?.type : null]);
    expect(causes).toEqual([
      ["job-approved", null],
      ["attempt-started", "job-approved"],
      ["stage-started", "attempt-started"],
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["branch-pushed", "stage-started"],
      ["pr-opened", "branch-pushed"],
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["evidence-recorded", "stage-started"], // verify
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["stage-failed", "stage-started"],
      ["bounced", "stage-failed"],
      ["stage-started", "bounced"],
      ["branch-pushed", "stage-started"],
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["evidence-recorded", "stage-started"], // verify
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["stage-passed", "stage-started"],
      ["stage-started", "stage-passed"],
      ["stage-passed", "stage-started"],
      ["merge-gate-evaluated", "stage-passed"],
      ["would-have-merged", "merge-gate-evaluated"],
      ["checkpoint-evaluated", "would-have-merged"],
      ["human-requested", "checkpoint-evaluated"],
    ]);
  });

  test("an edit to factory.yaml applies at the next Stage run, which records the config it used", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        triage: [
          () => {
            const file = join(f.home, "factory.yaml");
            writeFileSync(file, readFileSync(file, "utf8").replaceAll("tools: read-only, on_fail: build }", "tools: read-only, on_fail: build, model: claude-haiku-5-5 }"));
            return pass("Triaged.");
          },
        ],
        build: [building],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const reload = events.find((e) => e.type === "config-reloaded")!;
    const hashes = events.filter((e) => e.type === "stage-started").map((e) => e.data.config_hash);
    expect(hashes[0]).not.toBe(reload.data.config_hash);
    expect(hashes.slice(1).every((h) => h === reload.data.config_hash)).toBe(true);
    expect(f.agent.requests.map((r) => [r.brief.stage, r.model])).toEqual([
      ["triage", "claude-sonnet-5-5"],
      ["build", "claude-opus-5-5"],
      ["review", "claude-haiku-5-5"],
      ["security", "claude-haiku-5-5"],
    ]);
  });

  test("a Job whose labels can't be resolved asks a question instead of guessing", async () => {
    const f = fakeFactory();
    f.source.push(approved(7, ["pipeline:feature", "pipeline:ui"]));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual([]);
    expect(f.log.store.read().at(-1)).toMatchObject({
      type: "human-requested",
      data: { kind: "question", cause: "cannot-start", text: "Two Pipeline labels (pipeline:feature, pipeline:ui). The Job can't start until one is removed." },
    });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "cannot-start" });
  });

  test("one live Job per issue; removing the ready label cancels it", async () => {
    const f = fakeFactory();
    f.source.push(approved(7, ["pipeline:feature", "pipeline:ui"]), approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.log.jobs()).toHaveLength(1);

    f.source.push({ kind: "unapproved", repo: "acme/web-app", issue: 7, by: "alice" });
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob()).toMatchObject({ status: "cancelled", reason: "ready label removed" });
    expect(f.mirror.summary().at(-1)).toEqual(["job-cancelled", "cancelled", null]);
  });

  test("the same Check Stage command failing twice is a repeated root cause, even when its output differs", async () => {
    const config = fixture("e2e.yaml").replace(`verify: ['test -f "$PWD/built.txt"']`, () => `verify: ['echo pid $$; test -f "$PWD/built.txt"']`);
    const f = fakeFactory(new ScriptedAgent(), config);
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "build"]);
    expect(f.log.store.read().filter((e) => e.type === "bounced")).toHaveLength(1);
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "repeated-root-cause" });
  });
});
