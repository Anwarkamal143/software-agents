import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { building, pass, ScriptedAgent } from "./fakes/agent.js";
import { approved } from "./fakes/source.js";
import { fixture } from "./helpers/config.js";
import { fakeFactory } from "./helpers/factory.js";
import { agentGit, commitAll, writeIn } from "./helpers/git.js";

const withMaxRunning = (factory: number, repo?: number) =>
  fixture("e2e.yaml")
    .replace("humans: [alice]", `humans: [alice]\nmax_running: ${factory}`)
    .replace("default_pipeline: feature", `default_pipeline: feature${repo ? `\n    max_running: ${repo}` : ""}`);

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
}

/** Polls for up to 30s: in a full parallel run, starting a Job's first Stage run can take seconds. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 3000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("condition never held");
};

describe("Orchestrator with Trusted clones and Working copies", () => {
  test("an agent's commits are checked and pushed by the Orchestrator, which measures head and files changed itself", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [(req) => ({ ...building(req, { "src/health.ts": "export const ok = 1;\n" }), facts: { ...pass().facts, head: "claimed", files_changed: ["claimed.ts"] } })],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.store.read();
    const pushed = events.find((e) => e.type === "branch-pushed")!;
    expect(pushed).toMatchObject({ actor: "orchestrator", data: { branch: "factory/7", before: agentGit(f.remote, "rev-parse", "main") } });
    expect(agentGit(f.remote, "rev-parse", "factory/7")).toBe(pushed.data.head);
    const buildPassed = events.find((e) => e.type === "stage-passed" && e.data.stage === "build")!;
    expect(buildPassed.data).toMatchObject({ head: pushed.data.head, files_changed: ["built.txt", "src/health.ts"] });
    const verifyPassed = events.find((e) => e.type === "stage-passed" && e.data.stage === "verify")!;
    expect(verifyPassed.data.head).toBe(pushed.data.head);
    expect(f.agent.requests[1]!.workingCopy.dir).toBe(join(f.home, "work", f.onlyJob().job_id, "a1", "repo"));
    expect(f.agent.requests[1]!.workingCopy.env.HOME).toBe(join(f.home, "work", f.onlyJob().job_id, "a1", "home"));
    // The objects the Working copy's git borrows (--reference), so its commands may read them.
    const { dir, objects } = f.agent.requests[1]!.workingCopy;
    expect(objects).toBe(join(f.home, "repos", "acme", "web-app.git", "objects"));
    expect(realpathSync(readFileSync(join(dir, ".git", "objects", "info", "alternates"), "utf8").trim())).toBe(realpathSync(objects));
  });

  test("a failed Pre-push check pushes nothing and sends the Job to waiting", async () => {
    const f = fakeFactory(
      new ScriptedAgent({ build: [(req) => building(req, { "src/config.ts": `export const t = "ghp_${randomBytes(18).toString("hex")}";\n` })] }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.types(f.onlyJob().job_id).slice(-3)).toEqual(["stage-started", "prepush-failed", "human-requested"]);
    expect(f.log.store.read().find((e) => e.type === "prepush-failed")).toMatchObject({
      actor: "stage:build",
      data: { check: "secret-scan", failures: [{ check: "secret-scan", message: "gitleaks found 1 secret (github-pat)." }] },
    });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", stage: "build", reason: "prepush-failed" });
    expect(() => agentGit(f.remote, "rev-parse", "--verify", "-q", "refs/heads/factory/7")).toThrow();
    expect(f.agent.stagesRun()).toEqual(["triage", "build"]);
  });

  test("a read-only Stage that commits fails its Pre-push check", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        build: [building],
        review: [(req) => (writeIn(req.workingCopy.dir, "src/fix.ts", "// fixed it myself\n"), commitAll(req.workingCopy.dir), pass("LGTM"))],
      }),
    );
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().find((e) => e.type === "prepush-failed")?.data.check).toBe("tool-profile");
    expect(f.onlyJob()).toMatchObject({ status: "waiting", stage: "review", reason: "prepush-failed" });
  });

  test("a Check Stage sees only what was pushed, not uncommitted files in the Working copy", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [(req) => (writeIn(req.workingCopy.dir, "built.txt", "never committed\n"), pass("Built (not really)."))] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.log.store.read().find((e) => e.type === "stage-failed")).toMatchObject({ data: { stage: "verify", summary: '`test -f "$PWD/built.txt"` exited 1.' } });
  });

  test("with max_running: 1, a second Job waits in the queue until the first Stage run ends", async () => {
    const { gate, release } = deferred();
    const f = fakeFactory(new ScriptedAgent({ triage: [async () => (await gate, pass("A triaged."))] }), withMaxRunning(1));
    f.source.push(approved(1), approved(2));

    const done = f.orchestrator.runUntilIdle();
    await until(() => f.log.jobs().some((j) => j.status === "running"));
    await new Promise((r) => setTimeout(r, 200));
    const [a, b] = f.log.jobs();
    expect([a!.status, b!.status]).toEqual(["running", "queued"]);
    expect(f.types(b!.job_id)).not.toContain("stage-started");

    release();
    await done;
    const starts = f.log.store.read().filter((e) => e.type === "stage-started" || e.type === "stage-passed");
    const firstOfB = starts.findIndex((e) => e.job_id === b!.job_id);
    const aTriagePassed = starts.findIndex((e) => e.job_id === a!.job_id && e.type === "stage-passed");
    expect(firstOfB).toBeGreaterThan(aTriagePassed);
  });

  test("with max_running: 2, two Jobs' Stage runs overlap", async () => {
    const { gate, release } = deferred();
    const f = fakeFactory(new ScriptedAgent({ triage: [async () => (await gate, pass()), async () => (await gate, pass())] }), withMaxRunning(2));
    f.source.push(approved(1), approved(2));

    const done = f.orchestrator.runUntilIdle();
    await until(() => f.log.jobs().filter((j) => j.status === "running").length === 2);
    release();
    await done;
  });

  test("a repo's own max_running caps it below the Factory-wide limit", async () => {
    const { gate, release } = deferred();
    const f = fakeFactory(new ScriptedAgent({ triage: [async () => (await gate, pass())] }), withMaxRunning(2, 1));
    f.source.push(approved(1), approved(2));

    const done = f.orchestrator.runUntilIdle();
    await until(() => f.log.jobs().some((j) => j.status === "running"));
    await new Promise((r) => setTimeout(r, 200));
    expect(f.log.jobs().map((j) => j.status)).toEqual(["running", "queued"]);
    release();
    await done;
  });

  test("a resumed Job starts ahead of one approved earlier", async () => {
    const f = fakeFactory(new ScriptedAgent(), withMaxRunning(1));
    // Orchestrator decisions are a function of the Event log, so set the log up directly:
    // X is approved first and is queued; Y is approved later, asked a question, and answered.
    const admit = async (job_id: string, issue: number) => {
      f.log.record({ type: "job-approved", job_id, actor: "human:alice", data: { repo: "acme/web-app", issue, title: `Issue ${issue}`, body: "", labels: [] } });
      const wc = await f.clones.startAttempt({ repo: "acme/web-app", job_id, attempt: 1, branch: `factory/${issue}` });
      f.log.record({ type: "attempt-started", job_id, attempt: 1, actor: "orchestrator", data: { branch: wc.branch, base: wc.base } });
    };
    await admit("job-x", 1);
    await admit("job-y", 2);
    const y = { job_id: "job-y", attempt: 1, actor: "orchestrator" as const };
    f.log.record({ ...y, type: "human-requested", data: { kind: "question", text: "A or B?", options: ["A", "B"] } });
    f.log.record({ ...y, actor: "human:alice", type: "human-answered", data: { command: "answer", option: "A" } });
    expect(f.log.jobs().map((j) => [j.job_id, j.status, j.resumed])).toEqual([
      ["job-x", "queued", false],
      ["job-y", "queued", true],
    ]);

    await f.orchestrator.runUntilIdle();

    const firstStart = f.log.store.read().find((e) => e.type === "stage-started");
    expect(firstStart?.job_id).toBe("job-y");
  });

  test("cancelling a Job deletes its Working copies", async () => {
    const f = fakeFactory();
    f.source.push(approved(7, ["pipeline:feature", "pipeline:ui"])); // waits on a question, Working copy kept
    await f.orchestrator.runUntilIdle();
    const dir = join(f.home, "work", f.onlyJob().job_id);
    expect(existsSync(dir)).toBe(true);

    f.source.push({ kind: "unapproved", repo: "acme/web-app", issue: 7, by: "alice" });
    await f.orchestrator.runUntilIdle();
    expect(existsSync(dir)).toBe(false);
  });

  test("one Stage run throwing doesn't abandon the others still running", async () => {
    const { gate, release } = deferred();
    let otherFinished = false;
    const f = fakeFactory(
      new ScriptedAgent({
        triage: [
          async () => {
            throw new Error("adapter blew up");
          },
          async () => (await gate, (otherFinished = true), pass()),
        ],
      }),
      withMaxRunning(2),
    );
    f.source.push(approved(1), approved(2));

    const done = f.orchestrator.runUntilIdle();
    setTimeout(release, 300);
    await expect(done).rejects.toThrow("adapter blew up");
    expect(otherFinished).toBe(true);
  });
});
