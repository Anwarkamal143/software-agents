import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { srtSandbox } from "../src/stages/check-runner.js";
import { building, pass, ScriptedAgent } from "./fakes/agent.js";
import { switchableSandbox, unavailableSandbox } from "./fakes/sandbox.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { approved } from "./fakes/source.js";
import { fixture } from "./helpers/config.js";
import { fakeFactory } from "./helpers/factory.js";

afterAll(() => srtSandbox.close());

const SHOW_SECRETS = `"echo \\"stripe=\${STRIPE_KEY:-unset} other=\${OTHER_KEY:-unset}\\""`;

/** e2e.yaml whose verify gets STRIPE_KEY and lint gets no secret; each prints which check secrets it can see. */
const withSecrets = fixture("e2e.yaml")
  .replace("verify: { kind: check, run: verify, on_fail: build }", "verify: { kind: check, run: verify, on_fail: build, secrets: [STRIPE_KEY] }\n  lint: { kind: check, run: lint }")
  .replace("feature: { stages: [triage, build, verify, review, security] }", "feature: { stages: [triage, build, verify, lint, review, security] }")
  .replace(
    `commands: { verify: ['test -f "$PWD/built.txt"'] }`,
    `commands: { verify: ['test -f "$PWD/built.txt"', ${SHOW_SECRETS}], lint: [${SHOW_SECRETS}] }\n    check_secrets: [STRIPE_KEY]`,
  );

describe("Orchestrator: Check Stages under the Sandbox", () => {
  test("a Check Stage gets only the secrets it names, from its own repo, and its Evidence names the head commit and output artifact", async () => {
    // Another repo's STRIPE_KEY, and one stored without a repo, are never this repo's.
    const secrets = new FakeSecrets({ "check.acme.web-app.STRIPE_KEY": "sk_test_only", "check.acme.other.STRIPE_KEY": "other-repos", STRIPE_KEY: "no-repo", OTHER_KEY: "never-configured" });
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withSecrets, { secrets });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const pushed = events.find((e) => e.type === "branch-pushed")!;
    const passed = events.find((e) => e.type === "stage-passed" && e.data.stage === "verify")!;
    const [evidence, lintEvidence] = events.filter((e) => e.type === "evidence-recorded");
    const output = f.artifacts.get(String(evidence!.data.sha256)).toString();

    expect(output).toContain("stripe=sk_test_only other=unset");
    // lint names no secret, so it gets none, though its repo has one.
    expect(f.artifacts.get(String(lintEvidence!.data.sha256)).toString()).toContain("stripe=unset other=unset");
    expect(secrets.read).toEqual(["check.acme.web-app.STRIPE_KEY"]);
    expect(evidence).toMatchObject({
      actor: "orchestrator",
      stage_run_id: passed.stage_run_id,
      data: { stage: "verify", head: pushed.data.head, sha256: createHash("sha256").update(output).digest("hex"), size: Buffer.byteLength(output) },
    });
    expect(passed.data).toMatchObject({ head: pushed.data.head, output: { sha256: evidence!.data.sha256 }, violations: [] });
  });

  test("a failing Check Stage records its output but no Evidence: only a pass is proof", async () => {
    // The first build forgets built.txt, so verify fails; the second gets it right.
    const f = fakeFactory(new ScriptedAgent({ build: [pass("Built, honest."), building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const verifies = events.filter((e) => ["stage-passed", "stage-failed"].includes(e.type) && e.data.stage === "verify");
    expect(verifies.map((e) => e.type)).toEqual(["stage-failed", "stage-passed"]);
    expect(events.filter((e) => e.type === "evidence-recorded").map((e) => e.stage_run_id)).toEqual([verifies[1]!.stage_run_id]);
  });

  test("with the Sandbox lost after the self-check, the Check Stage doesn't run and the Factory pauses", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), fixture("e2e.yaml"), { sandbox: unavailableSandbox(), checkSandboxSelfCheck: switchableSandbox(true) });
    f.source.push(approved(7));
    f.source.push(approved(8));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const paused = events.find((e) => e.type === "factory-paused")!;
    expect(paused).toMatchObject({ job_id: null, data: { reason: "sandbox-unavailable", message: expect.stringContaining("bubblewrap is not installed") } });
    // The run ends without a Verdict or Evidence; the Job waits for the Factory, not a human.
    const first = events.find((e) => e.type === "stage-interrupted")!;
    expect(first).toMatchObject({ data: { stage: "verify", reason: "sandbox-unavailable" }, caused_by: paused.id });
    expect(events.filter((e) => ["evidence-recorded", "human-requested"].includes(e.type))).toEqual([]);
    expect(f.log.jobs().map((j) => [j.issue, j.status, j.reason])).toEqual([
      [7, "paused", "factory-paused"],
      [8, "paused", "factory-paused"],
    ]);
    expect(f.agent.stagesRun().filter((s) => s === "review")).toEqual([]);
  });

  test("a configured check secret missing from the keychain pauses the Factory before anything runs", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withSecrets, { secrets: new FakeSecrets({}) });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().find((e) => e.type === "factory-paused")).toMatchObject({
      data: { reason: "check-secret-missing", message: "Check secret STRIPE_KEY isn't in the keychain for acme/web-app (set it with `factory secret set acme/web-app STRIPE_KEY`)." },
    });
    expect(f.onlyJob()).toMatchObject({ status: "paused", stage: "verify", reason: "factory-paused" });
  });
});

describe("Orchestrator: the Sandbox self-check (ADR 0007)", () => {
  test.each([
    ["Check Stage", { checkSandboxSelfCheck: unavailableSandbox() }],
    ["agent", { agentSandbox: unavailableSandbox() }],
  ])("with the %s Sandbox unavailable, no Stage run starts: the Factory pauses before spending anything", async (_, opts) => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), fixture("e2e.yaml"), opts);
    f.source.push(approved(7));
    f.source.push(approved(8));

    await f.orchestrator.start();
    await f.orchestrator.runUntilIdle();
    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    expect(f.agent.stagesRun()).toEqual([]);
    expect(events.filter((e) => ["stage-started", "stage-resumed"].includes(e.type))).toEqual([]);
    // Paused once, however often it looks again.
    expect(events.filter((e) => e.type === "factory-paused").map((e) => e.data)).toEqual([{ reason: "sandbox-unavailable", message: "bubblewrap is not installed" }]);
    expect(f.log.jobs().map((j) => [j.issue, j.status, j.reason])).toEqual([
      [7, "paused", "factory-paused"],
      [8, "paused", "factory-paused"],
    ]);
  });

  test("once the Sandbox is available, the self-check lifts its pause and the Jobs go on; it isn't asked again", async () => {
    const sandbox = switchableSandbox(false);
    const f = fakeFactory(new ScriptedAgent({ triage: [pass("ok")], build: [building] }), fixture("e2e.yaml"), { agentSandbox: sandbox });
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "factory-paused" });

    sandbox.available = true;
    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const paused = events.find((e) => e.type === "factory-paused")!;
    expect(events.find((e) => e.type === "factory-resumed")).toMatchObject({ caused_by: paused.id });
    expect(f.agent.stagesRun()).toContain("build");
    const calls = sandbox.readyCalls;
    await f.orchestrator.runUntilIdle();
    expect(sandbox.readyCalls).toBe(calls);
  });

  test("the self-check lifts only its own kind of pause", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }));
    f.log.record({ type: "factory-paused", actor: "orchestrator", data: { reason: "check-secret-missing", message: "Check secret X isn't in the keychain" } });
    f.source.push(approved(7));
    await f.orchestrator.start();
    await f.orchestrator.runUntilIdle();
    expect(f.log.store.read().some((e) => e.type === "factory-resumed")).toBe(false);
    expect(f.agent.stagesRun()).toEqual([]);
  });
});
