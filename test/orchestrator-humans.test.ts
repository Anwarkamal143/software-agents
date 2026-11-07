import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunOutcome } from "../src/agents/adapter.js";
import { runCli } from "../src/cli/run.js";
import { approved, comment } from "./fakes/source.js";
import { asks, building, fail, finding, pass, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory, expectAtMergeGate } from "./helpers/factory.js";
import { agentGit } from "./helpers/git.js";
import { fixture } from "./helpers/config.js";

async function cli(home: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { home, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: (s: string) => void (stderr += s) } });
  return { code, stdout, stderr };
}

const DAY = 24 * 60 * 60 * 1000;
/** A clock the test moves on. */
function clock() {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), advance: (ms: number) => void (offset += ms) };
}

/** A review whose Stage result doesn't fit the schema: a Run error. Twice in a row, it asks for approval. */
const invalid: AgentRunOutcome = { kind: "output", output: { verdict: "pass" }, facts: pass().facts };

describe("Orchestrator: Human requests and Reply commands", () => {
  test("a Job waiting on a question resumes the same Stage's session with the answer as marked human input", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("REST or GraphQL?", ["REST", "GraphQL"], "session-7")], build: [building] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "question", stage: "triage" });

    f.source.push(comment(7, "/answer B"));
    await f.orchestrator.runUntilIdle();

    const resumed = f.agent.requests[1]!;
    expect(resumed.brief.stage).toBe("triage");
    expect(resumed.resume?.session_id).toBe("session-7");
    expect(resumed.resume?.input).toMatch(/^<human-input from="human:alice" via="github" boundary="[0-9a-f]+">/);
    expect(resumed.resume?.input).toContain("Question from triage: REST or GraphQL?\nAnswer: GraphQL");

    const events = f.log.store.read();
    const answered = events.find((e) => e.type === "human-answered")!;
    expect(answered).toMatchObject({ actor: "human:alice", data: { command: "answer", option: "B", text: "GraphQL", channel: "github" } });
    const resumedEvent = events.find((e) => e.type === "stage-resumed")!;
    expect(resumedEvent).toMatchObject({ caused_by: answered.id, data: { stage: "triage", session_id: "session-7", answer: answered.id } });
    // Later Stages see the Q&A too, as human input.
    expect(f.agent.requests.find((r) => r.brief.stage === "build")!.renderedBrief).toContain("Answer: GraphQL");
    expectAtMergeGate(f.log.store.read());
  });

  test("after 7 days the answer starts a fresh Stage run of the same Stage with the Q&A in its brief", async () => {
    const time = clock();
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("REST or GraphQL?", ["REST", "GraphQL"])], build: [building] }), undefined, { now: time.now });
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    time.advance(8 * DAY);
    const { code } = await cli(f.home, "answer", f.onlyJob().job_id, "A");
    expect(code).toBe(0);
    await f.orchestrator.runUntilIdle();

    const fresh = f.agent.requests[1]!;
    expect(fresh.brief.stage).toBe("triage");
    expect(fresh.resume).toBeUndefined();
    expect(fresh.renderedBrief).toContain('<human-input from="cli" via="cli"');
    expect(fresh.renderedBrief).toContain("Question from triage: REST or GraphQL?\nAnswer: REST");
    expect(f.log.store.read().some((e) => e.type === "stage-resumed")).toBe(false);
  });

  test("a resume that fails runs the Stage fresh with the Q&A, and records why", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        triage: [asks("Which region?", ["EU", "US"]), { kind: "resume-failed", message: "session not found" }, pass("Triaged.")],
        build: [building],
      }),
    );
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.source.push(comment(7, "/answer other: both, EU first"));
    await f.orchestrator.runUntilIdle();

    const [, resumed, fresh] = f.agent.requests;
    expect(resumed!.resume).toBeDefined();
    expect(fresh!.resume).toBeUndefined();
    expect(fresh!.renderedBrief).toContain("Answer: both, EU first");
    expect(f.log.store.read().find((e) => e.type === "stage-passed" && e.data.stage === "triage")?.data.resume_failed).toBe("session not found");
  });

  test("a fresh Stage run that also reports a failed resume is a Run error, not a loop", async () => {
    const resumeFailed: AgentRunOutcome = { kind: "resume-failed", message: "session not found" };
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("Which region?", ["EU", "US"]), resumeFailed, resumeFailed, pass("Triaged.")], build: [building] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.source.push(comment(7, "/answer A"));
    await f.orchestrator.runUntilIdle();

    // Ask, resume, fresh: a Run error. Its retry is one more fresh run, not another loop.
    expect(f.agent.stagesRun().filter((s) => s === "triage")).toHaveLength(4);
    const errored = f.log.store.read().find((e) => e.type === "stage-errored")!;
    expect(errored).toMatchObject({ data: { stage: "triage", reason: "sdk-error" } });
    expect(f.log.store.read().find((e) => e.type === "stage-started" && e.data.retry_of === errored.id)).toBeDefined();
  });

  test("/reject Bounces to build with the reason as a finding", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building, building], review: [invalid, invalid] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "repeated-run-error" });
    expect(f.log.store.read().at(-1)?.data).toMatchObject({ kind: "approval", stage: "review", reject_to: "build" });

    f.source.push(comment(7, "/reject No test covers /health."));
    await f.orchestrator.runUntilIdle();

    const bounced = f.log.store.read().find((e) => e.type === "bounced")!;
    expect(bounced).toMatchObject({ actor: "human:alice", data: { from: "review", to: "build", bounce: 1, finding: { message: "No test covers /health.", root_cause: "human-reject" } } });
    const rebuild = f.agent.requests.filter((r) => r.brief.stage === "build")[1]!;
    expect(rebuild.brief.earlier.at(-1)).toMatchObject({ stage: "human", verdict: "fail", findings: [{ message: "No test covers /health." }] });
    expectAtMergeGate(f.log.store.read());
  });

  test("/approve at the Bounce cap Bounces once more", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: Array.from({ length: 5 }, () => building),
        review: [1, 2, 3, 4].map((n) => fail(`Round ${n}.`, [finding(`problem-${n}`)])),
      }),
    );
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "bounce-cap" });

    f.source.push(comment(7, "/approve"));
    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "bounced").map((e) => e.data.bounce)).toEqual([1, 2, 3, 4]);
    expectAtMergeGate(f.log.store.read());
  });

  test("/cancel once the Factory has given up fails the Job: its draft PR, branches and Working copy are kept to look at", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: Array.from({ length: 4 }, () => building),
        review: [1, 2, 3, 4].map((n) => fail(`Round ${n}.`, [finding(`problem-${n}`)])),
      }),
    );
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const { job_id } = f.onlyJob();
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "bounce-cap" });

    f.source.push(comment(7, "/cancel"));
    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob()).toMatchObject({ status: "failed", reason: "review failed after 3 Bounces (cap 3). Round 4." });
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "job-failed", actor: "human:alice", data: { reason: "review failed after 3 Bounces (cap 3). Round 4." } });
    expect(existsSync(join(f.home, "work", job_id))).toBe(true);
    expect(agentGit(f.remote, "rev-parse", "--verify", "-q", "refs/heads/factory/7")).toMatch(/^[0-9a-f]{40}$/);
    // Only a human starts the next Attempt.
    expect(await cli(f.home, "retry", job_id)).toMatchObject({ code: 0 });
  });

  test("/cancel from the CLI cancels the Job and removes its Working copies", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("Sure?", ["Yes", "No"])] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const { job_id } = f.onlyJob();

    expect(await cli(f.home, "cancel", job_id)).toMatchObject({ code: 0, stdout: `Recorded /cancel for Job ${job_id}. The Factory acts on it at its next step.\n` });
    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob()).toMatchObject({ status: "cancelled", reason: "cancelled by cli" });
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "job-cancelled", actor: "cli" });
    expect(existsSync(join(f.home, "work", job_id))).toBe(false);
  });

  test("a command from someone not on humans, without write access, malformed, or written before the request is ignored and logged", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("Sure?", ["Yes", "No"])] }));
    f.source.writers.delete("bob");
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    f.source.push(
      comment(7, "/answer A", { by: "mallory" }),
      comment(7, "/answer A", { created_at: "2020-01-01T00:00:00.000Z" }),
      comment(7, "/answer maybe"),
      comment(7, "/answer maybe", { by: "mallory" }),
      comment(7, "Thanks, looking now."),
    );
    await f.orchestrator.runUntilIdle();

    const ignored = f.log.store.read().filter((e) => e.type === "reply-ignored");
    expect(ignored.map((e) => [e.actor, e.data.why])).toEqual([
      ["human:mallory", "not-allowed"],
      ["human:alice", "before-request"],
      ["human:alice", "malformed"],
      // A stranger isn't told how to get it right.
      ["human:mallory", "not-allowed"],
    ]);
    expect(f.mirror.summary().slice(-4).map(([type, status]) => [type, status])).toEqual(Array(4).fill(["reply-ignored", "waiting"]));
    expect(f.onlyJob()).toMatchObject({ status: "waiting" });
    expect(f.agent.stagesRun()).toEqual(["triage"]);
  });

  test("a GitHub and a CLI reply race: the first recorded wins and the second is told it was already answered", async () => {
    const config = fixture("e2e.yaml").replace("humans: [alice]", "humans: [alice, bob]");
    const f = fakeFactory(new ScriptedAgent({ build: [building], review: [invalid, invalid] }), config);
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const { job_id } = f.onlyJob();

    // bob's /approve and the CLI's /cancel both come after the request; the CLI is recorded first.
    f.source.push(comment(7, "/approve", { by: "bob" }));
    expect((await cli(f.home, "cancel", job_id)).code).toBe(0);
    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "human-answered").map((e) => e.data.command)).toEqual(["cancel"]);
    const ignored = f.log.store.read().find((e) => e.type === "reply-ignored")!;
    expect(ignored).toMatchObject({ actor: "human:bob", data: { why: "already-answered", channel: "github" } });
    expect(f.mirror.writes.some((w) => w.event.id === ignored.id)).toBe(true);
    // The request was the Factory giving up (review's retries ran out), so the /cancel fails the Job.
    expect(f.onlyJob()).toMatchObject({ status: "failed" });

    // The other way round: a CLI reply after the GitHub one is told so.
    const g = fakeFactory(new ScriptedAgent({ build: [building], review: [invalid, invalid] }));
    g.source.push(approved(8));
    await g.orchestrator.runUntilIdle();
    g.source.push(comment(8, "/approve"));
    // Recorded, not yet acted on: acting on it would take the Job on to the Merge gate's own request.
    await g.orchestrator.poll();
    expect(await cli(g.home, "reject", g.onlyJob().job_id, "too", "late")).toMatchObject({ code: 1, stderr: `Job ${g.onlyJob().job_id}'s request was already answered.\n` });
  });

  test("an edit to a recorded reply changes nothing", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("Sure?", ["Yes", "No"]), (): AgentRunOutcome => asks("Really?", ["Yes", "No"])] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.source.push(comment(7, "/answer A", { id: "c-1" }));
    await f.orchestrator.runUntilIdle();

    f.source.push(comment(7, "/answer B", { id: "c-1" }));
    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().filter((e) => e.type === "human-answered").map((e) => e.data.text)).toEqual(["Yes"]);
    expect(f.log.store.read().at(-1)?.data).toMatchObject({ why: "edited-after-recording" });
  });

  test("each Human request notifies this machine; a waiting one gets one reminder after 3 days", async () => {
    const time = clock();
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("REST or GraphQL?", ["REST", "GraphQL"])] }), undefined, { now: time.now });
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.notifier.notes).toEqual([{ title: "Factory: acme/web-app#7 needs you", body: "REST or GraphQL?" }]);

    time.advance(2 * DAY);
    await f.orchestrator.runUntilIdle();
    expect(f.log.store.read().some((e) => e.type === "human-reminded")).toBe(false);

    time.advance(1 * DAY + 1);
    await f.orchestrator.runUntilIdle();
    await f.orchestrator.runUntilIdle();
    const reminders = f.log.store.read().filter((e) => e.type === "human-reminded");
    const request = f.log.store.read().find((e) => e.type === "human-requested")!;
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ caused_by: request.id, data: { request: request.id } });
    expect(f.mirror.summary().at(-1)).toEqual(["human-reminded", "waiting", "triage"]);
  });

  test("a waiting Job holds no concurrency slot", async () => {
    const config = fixture("e2e.yaml").replace("humans: [alice]", "humans: [alice]\nmax_running: 1");
    const f = fakeFactory(new ScriptedAgent({ triage: [asks("Sure?", ["Yes", "No"])], build: [building] }), config);
    f.source.push(approved(7), approved(8));

    await f.orchestrator.runUntilIdle();

    expect(f.log.jobs().map((j) => [j.issue, j.status])).toEqual([
      [7, "waiting"],
      [8, "waiting"],
    ]);
    expectAtMergeGate(f.log.store.read().filter((e) => e.job_id === f.log.jobs()[1]!.job_id));
  });
});
