import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli/run.js";
import { approved, comment } from "./fakes/source.js";
import { building, ScriptedAgent } from "./fakes/agent.js";
import { fakeFactory } from "./helpers/factory.js";
import { agentGit } from "./helpers/git.js";

async function cli(home: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { home, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: (s: string) => void (stderr += s) } });
  return { code, stdout, stderr };
}

/** A Job of issue 7 whose first Attempt the test ends with `ending`. */
async function endedJob(ending: "job-failed" | "job-cancelled") {
  const f = fakeFactory(new ScriptedAgent({ build: [building, building] }));
  f.source.push(approved(7));
  await f.orchestrator.runUntilIdle();
  const { job_id } = f.onlyJob();
  f.log.record({ type: ending, job_id, attempt: 1, actor: "orchestrator", data: ending === "job-failed" ? { reason: "gave up" } : {} });
  return { f, job_id };
}

describe("Orchestrator: only a human starts a new Attempt", () => {
  test("re-labelling a cancelled Job starts its next Attempt on its own branch, from the default branch", async () => {
    const { f, job_id } = await endedJob("job-cancelled");

    f.source.push(approved(7, [], "Now with more detail."));
    await f.orchestrator.runUntilIdle();

    expect(f.log.jobs()).toHaveLength(1);
    const events = f.log.eventsFor(job_id);
    const retried = events.find((e) => e.type === "job-retried")!;
    expect(retried).toMatchObject({ actor: "human:alice", data: { body: "Now with more detail." } });
    const started = events.filter((e) => e.type === "attempt-started").at(-1)!;
    expect(started).toMatchObject({ attempt: 2, caused_by: retried.id, data: { branch: "factory/7-a2", base: agentGit(f.remote, "rev-parse", "main") } });
    expect(f.onlyJob()).toMatchObject({ attempt: 2 });
    // The new Attempt runs from the first Stage, with the re-approved text.
    const second = f.agent.requests.filter((r) => r.brief.attempt === 2);
    expect(second.map((r) => r.brief.stage)).toEqual(["triage", "build", "review", "security"]);
    expect(second[0]!.brief.issue.body).toBe("Now with more detail.");
    expect(events.at(-1)).toMatchObject({ type: "checkpoint-evaluated" });
  });

  test("factory retry starts a failed Job's next Attempt", async () => {
    const { f, job_id } = await endedJob("job-failed");

    expect(await cli(f.home, "retry", job_id)).toMatchObject({ code: 0 });
    await f.orchestrator.runUntilIdle();

    const retried = f.log.eventsFor(job_id).find((e) => e.type === "job-retried")!;
    expect(retried.actor).toBe("cli");
    expect(f.onlyJob()).toMatchObject({ attempt: 2 });
    expect(f.log.eventsFor(job_id).at(-1)).toMatchObject({ type: "checkpoint-evaluated", attempt: 2 });
  });

  test("factory retry refuses a Job that hasn't failed or been cancelled", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    const out = await cli(f.home, "retry", f.onlyJob().job_id);

    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/only a failed or cancelled Job can be retried/);
    expect(f.log.store.read().some((e) => e.type === "job-retried")).toBe(false);
  });

  test("a merged Job's issue needs a new Job: re-labelling it starts one", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building, building] }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const first = f.onlyJob().job_id;
    f.log.record({ type: "pr-merged", job_id: first, attempt: 1, actor: "orchestrator", data: {} });

    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();

    expect(f.log.jobs().map((j) => [j.job_id === first, j.status, j.attempt])).toEqual([
      [true, "merged", 1],
      [false, "queued", 1],
    ]);
  });

  test("the Orchestrator never starts a new Attempt by itself: a Job out of retries waits", async () => {
    const f = fakeFactory(new ScriptedAgent({ triage: Array.from({ length: 3 }, (_, i) => ({ kind: "error" as const, reason: "timeout" as const, message: `t${i}`, facts: { cost_usd: 0, tokens: 0, turns: 0, duration_ms: 0, head: null, files_changed: [] } })) }));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.source.push(comment(7, "hello"));
    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob()).toMatchObject({ status: "waiting", attempt: 1 });
    expect(f.log.store.read().filter((e) => e.type === "attempt-started")).toHaveLength(1);
  });
});
