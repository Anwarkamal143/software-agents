import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { srtSandbox } from "../src/stages/check-runner.js";
import { building, pass, ScriptedAgent } from "./fakes/agent.js";
import { unavailableSandbox } from "./fakes/sandbox.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { approved } from "./fakes/source.js";
import { fixture } from "./helpers/config.js";
import { fakeFactory } from "./helpers/factory.js";

afterAll(() => srtSandbox.close());

/** e2e.yaml whose verify prints which check secrets it can see. */
const withSecrets = fixture("e2e.yaml").replace(
  'commands: { verify: ["test -f built.txt"] }',
  'commands: { verify: ["test -f built.txt", "echo \\"stripe=${STRIPE_KEY:-unset} other=${OTHER_KEY:-unset}\\""] }\n    check_secrets: [STRIPE_KEY]',
);

describe("Orchestrator: Check Stages under the Sandbox", () => {
  test("a Check Stage gets only its configured secrets, and its Evidence names the head commit and output artifact", async () => {
    const secrets = new FakeSecrets({ STRIPE_KEY: "sk_test_only", OTHER_KEY: "never-configured" });
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withSecrets, { secrets });
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const pushed = events.find((e) => e.type === "branch-pushed")!;
    const passed = events.find((e) => e.type === "stage-passed" && e.data.stage === "verify")!;
    const evidence = events.find((e) => e.type === "evidence-recorded")!;
    const output = f.artifacts.get(String(evidence.data.sha256)).toString();

    expect(output).toContain("stripe=sk_test_only other=unset");
    expect(secrets.read).toEqual(["STRIPE_KEY"]);
    expect(evidence).toMatchObject({
      actor: "orchestrator",
      stage_run_id: passed.stage_run_id,
      data: { stage: "verify", head: pushed.data.head, sha256: createHash("sha256").update(output).digest("hex"), size: Buffer.byteLength(output) },
    });
    expect(passed.data).toMatchObject({ head: pushed.data.head, output: { sha256: evidence.data.sha256 }, violations: [] });
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

  test("with the Sandbox unavailable, the Check Stage doesn't run and the Factory pauses", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), fixture("e2e.yaml"), { sandbox: unavailableSandbox() });
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
      data: { reason: "check-secret-missing", message: expect.stringContaining("STRIPE_KEY") },
    });
    expect(f.onlyJob()).toMatchObject({ status: "paused", stage: "verify", reason: "factory-paused" });
  });
});
