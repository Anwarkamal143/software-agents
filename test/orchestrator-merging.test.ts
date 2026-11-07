import { describe, expect, test } from "vitest";
import type { AgentRunRequest } from "../src/agents/adapter.js";
import { building, pass, ScriptedAgent } from "./fakes/agent.js";
import { approved, comment } from "./fakes/source.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/config.js";
import { factoryAt, fakeFactory } from "./helpers/factory.js";
import type { JobStore } from "../src/store/job-store.js";
import { JobStoreUnwritable } from "../src/orchestrator/orchestrator.js";
import { GitHubRefused, GitHubUnavailable } from "../src/github/client.js";
import { runCli } from "../src/cli/run.js";

async function cli(home: string, ...argv: string[]) {
  let stdout = "";
  const code = await runCli(argv, { home, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: () => undefined } });
  return { code, stdout };
}
import { agentGit, commitAll, writeIn } from "./helpers/git.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** The e2e config at an Autonomy level. */
const withAutonomy = (autonomy: "off" | "trial" | "auto") => fixture("e2e.yaml").replace("  bounce_cap: 3", `  bounce_cap: 3\n  autonomy: ${autonomy}`);
const remoteHas = (remote: string, ref: string) => {
  try {
    agentGit(remote, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

/** A build that adds its own file, and the built.txt verify looks for, the same in every Job: no conflict. */
const buildsOwn = (file: string) => (req: AgentRunRequest) => {
  writeIn(req.workingCopy.dir, "built.txt", "built\n");
  writeIn(req.workingCopy.dir, file, `export const x = "${file}";\n`);
  commitAll(req.workingCopy.dir, `Add ${file}`);
  return pass(`Added ${file}.`);
};

/** Someone pushes to a branch on GitHub, outside the Factory. */
function pushOutside(remote: string, branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    agentGit(dir, "clone", "-q", "-b", branch, remote, ".");
    writeIn(dir, "sneaky.txt", "not checked\n");
    commitAll(dir, "Sneak one in");
    agentGit(dir, "push", "-q", "origin", branch);
    return agentGit(dir, "rev-parse", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PRs and merging", () => {
  test("after build pushes, the Orchestrator opens a draft PR for the Job branch", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const pr = f.pulls.of("factory/7")!;
    expect(pr).toMatchObject({ base: "main", title: "Issue 7", state: "open" });
    expect(pr.body).toContain("Closes #7");
    const types = f.types(f.onlyJob().job_id);
    expect(types.indexOf("pr-opened")).toBe(types.indexOf("branch-pushed") + 1);
    expect(f.log.store.read().find((e) => e.type === "pr-opened")?.data).toEqual({ number: pr.number, url: `https://github.com/acme/web-app/pull/${pr.number}` });
    expect(f.pulls.calls.filter((c) => c.startsWith("open"))).toHaveLength(1);
    expect(agentGit(f.remote, "rev-parse", "factory/7")).toBe(f.log.store.read().find((e) => e.type === "branch-pushed")?.data.head);
  });

  test("trial never merges without /approve, and records whether it would have merged and why", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("trial"));
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const job = f.onlyJob();
    expect(f.types(job.job_id).slice(-4)).toEqual(["merge-gate-evaluated", "would-have-merged", "checkpoint-evaluated", "human-requested"]);
    const events = f.log.eventsFor(job.job_id);
    expect(events.find((e) => e.type === "would-have-merged")?.data).toEqual({ would: true, why: "the Merge gate passed and no Risk rule matched" });
    expect(events.at(-1)?.data).toMatchObject({ kind: "approval", cause: "autonomy" });
    expect(String(events.at(-1)?.data.text)).toContain("In auto, the Factory would have merged: the Merge gate passed and no Risk rule matched.");
    expect(job).toMatchObject({ status: "waiting", reason: "autonomy" });
    expect(f.pulls.calls.some((c) => c.startsWith("merge"))).toBe(false);
    // Ready for you to review and merge yourself.
    expect(f.pulls.of("factory/7")?.draft).toBe(false);
  });

  test("after /approve, the Factory merges through the gate, and the ending deletes the branches and the Working copy", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("off"));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const job_id = f.onlyJob().job_id;
    expect(f.types(job_id)).not.toContain("would-have-merged");

    f.source.push(comment(7, "/approve"));
    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob().status).toBe("merged");
    const merged = f.log.eventsFor(job_id).findLast((e) => e.type === "pr-merged")!;
    const pr = f.pulls.of("factory/7")!;
    expect(merged).toMatchObject({ actor: "orchestrator", data: { number: pr.number, sha: pr.mergedAs } });
    expect(agentGit(f.remote, "rev-parse", "main")).toBe(pr.mergedAs);
    expect(agentGit(f.remote, "show", "main:built.txt")).toMatch(/^build \d+$/);
    expect(remoteHas(f.remote, "refs/heads/factory/7")).toBe(false);
    expect(existsSync(join(f.home, "work", job_id))).toBe(false);
  });

  test("two Jobs in one repo: the second is rebased onto the first's merge and re-checked before it merges", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [buildsOwn("src/seven.ts"), buildsOwn("src/eight.ts")] }), withAutonomy("auto"));
    f.source.push(approved(7), approved(8));

    await f.orchestrator.runUntilIdle();

    expect(f.log.jobs().map((j) => j.status)).toEqual(["merged", "merged"]);
    const [first, second] = f.log.store.read().filter((e) => e.type === "pr-merged").map((e) => e.job_id!);
    expect(f.types(first!)).not.toContain("rebased");
    const events = f.log.eventsFor(second!);
    const rebased = events.find((e) => e.type === "rebased")!;
    const firstMerge = f.log.eventsFor(first!).find((e) => e.type === "pr-merged")!;
    expect(rebased.data).toMatchObject({ base: firstMerge.data.sha, before: events.findLast((e) => e.type === "branch-pushed")?.data.head });
    // What the gate decided was to rebase first: no merge happened at the old head.
    expect(events[events.indexOf(rebased) - 1]).toMatchObject({
      type: "checkpoint-evaluated",
      data: { checkpoint: "merge-gate", outcome: "rebase", why: `the default branch moved to ${String(firstMerge.data.sha).slice(0, 12)}: rebasing, then the Check Stages run again` },
    });
    const after = events.slice(events.indexOf(rebased) + 1);
    expect(after.map((e) => e.type)).toEqual([
      "stage-started", "evidence-recorded", "stage-passed", // verify, again, on the rebased head
      "merge-gate-evaluated", "checkpoint-evaluated", "pr-merged",
    ]);
    expect(after[1]!.data.head).toBe(rebased.data.head);
    expect(after[3]!.data).toMatchObject({ passed: true, head: rebased.data.head });
    // Agent Stages didn't run again: their passes carried over.
    expect(f.agent.stagesRun().filter((s) => s === "review")).toHaveLength(2);
    for (const file of ["src/seven.ts", "src/eight.ts"]) expect(agentGit(f.remote, "show", `main:${file}`)).toContain(file);
  });

  test("a Job whose rebase conflicts Bounces to build with the conflicting files as findings", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building, building] }), withAutonomy("auto"));
    f.source.push(approved(7), approved(8));

    await f.orchestrator.runUntilIdle();

    // Whichever reached the gate first merged; the other conflicts with it.
    const merged = f.log.jobs().find((j) => j.status === "merged");
    const conflicted = f.log.jobs().find((j) => j.job_id !== merged?.job_id);
    expect(merged).toBeDefined();
    const bounced = f.log.eventsFor(conflicted!.job_id).find((e) => e.type === "bounced")!;
    const base = f.log.eventsFor(merged!.job_id).find((e) => e.type === "pr-merged")!.data.sha as string;
    expect(bounced.data).toMatchObject({
      from: "merge-gate",
      to: "build",
      bounce: 1,
      findings: [{ severity: "error", file: "built.txt", root_cause: "rebase-conflict:built.txt" }],
    });
    expect(String((bounced.data.findings as { message: string }[])[0]!.message)).toContain(`Merge ${base} into the branch`);
    expect(f.log.eventsFor(conflicted!.job_id).some((e) => e.type === "rebased")).toBe(false);
    const conflictEvents = f.log.eventsFor(conflicted!.job_id);
    expect(conflictEvents[conflictEvents.indexOf(conflictEvents.find((e) => e.id === bounced.id)!) - 1]).toMatchObject({ type: "checkpoint-evaluated", data: { outcome: "rebase-conflict" } });
    // Build runs again with the conflict in its brief.
    const rebuild = f.agent.requests.filter((r) => r.brief.stage === "build" && r.job_id === conflicted!.job_id).at(-1)!;
    expect(rebuild.brief.earlier.at(-1)).toMatchObject({ stage: "merge-gate", verdict: "fail", findings: [{ root_cause: "rebase-conflict:built.txt" }] });
    // That build changed nothing, so the same conflict comes back: a human decides.
    expect(conflicted).toMatchObject({ status: "waiting", reason: "repeated-root-cause" });
  });

  test("a head change between check and merge makes --match-head-commit refuse, and the gate runs again", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    let sneaked = "";
    f.pulls.beforeMerge = (pr) => {
      sneaked = pushOutside(f.remote, pr.branch);
      f.pulls.beforeMerge = null;
    };
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const events = f.log.eventsFor(f.onlyJob().job_id);
    const refused = events.findIndex((e) => e.data.outcome === "merge-refused");
    expect(events[refused - 1]).toMatchObject({ type: "checkpoint-evaluated", data: { outcome: "merge" } });
    expect(String(events[refused]!.data.why)).toContain("Head branch was modified");
    expect(events.slice(refused + 1).map((e) => e.type)).toEqual(["merge-gate-evaluated", "checkpoint-evaluated", "human-requested"]);
    expect(events[refused + 1]!.data).toMatchObject({ passed: false, head: sneaked, failures: expect.arrayContaining([{ code: "evidence", why: `no Evidence for the head ${sneaked}` }]) });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "merge-gate" });
    expect(f.log.store.read().some((e) => e.type === "pr-merged")).toBe(false);
  });

  describe("the post-merge watch", () => {
    const merged = async (autonomy: "auto" | "trial", time = { now: () => new Date() }) => {
      const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy(autonomy), time);
      f.source.push(approved(7));
      await f.orchestrator.runUntilIdle();
      if (autonomy !== "auto") {
        f.source.push(comment(7, "/approve"));
        await f.orchestrator.runUntilIdle();
      }
      const job = f.onlyJob();
      expect(job.status).toBe("merged");
      const sha = f.log.eventsFor(job.job_id).findLast((e) => e.type === "pr-merged")!.data.sha as string;
      return { f, job, sha };
    };

    test("a red CI run after an auto-merge opens a revert PR and merges it, and starts no new Job", async () => {
      const { f, job, sha } = await merged("auto");
      f.pulls.checksOf.set(sha, "red");

      await f.orchestrator.runUntilIdle();

      const events = f.log.eventsFor(job.job_id);
      const revert = f.pulls.of("factory/7-revert-101")!;
      expect(events.slice(-4).map((e) => [e.type, e.data])).toEqual([
        ["checkpoint-evaluated", { checkpoint: "after-merge", outcome: "red", why: `CI on the default branch went red at ${sha.slice(0, 12)} after #101 merged.` }],
        ["reverted", { revert_pr: revert.number, merged: true, why: `CI on the default branch went red at ${sha.slice(0, 12)} after #101 merged.` }],
        ["issue-reopened", {}],
        ["ready-label-removed", { label: "factory:ready" }],
      ]);
      expect(revert.state).toBe("merged");
      expect(f.pulls.reopened).toEqual([7]);
      expect(f.pulls.labelsRemoved).toEqual(["7 factory:ready"]);
      expect(() => agentGit(f.remote, "show", "main:built.txt")).toThrow();
      expect(f.onlyJob()).toMatchObject({ status: "merged" });

      // Reopening the issue starts nothing on its own, and the watch is over.
      f.source.push({ kind: "reopened", repo: "acme/web-app", issue: 7, by: "alice" });
      await f.orchestrator.runUntilIdle();
      expect(f.log.jobs()).toHaveLength(1);
      expect(f.pulls.calls.filter((c) => c.startsWith("open factory/7-revert"))).toHaveLength(1);
      expect(remoteHas(f.remote, "refs/heads/factory/7-revert-101")).toBe(false);
    });

    test("a revert merge GitHub refuses for a permission leaves the revert PR open for you and pauses the Factory, saying why", async () => {
      const { f, job, sha } = await merged("auto");
      f.pulls.checksOf.set(sha, "red");
      f.pulls.refuse = (what) => (what === "merge 102" ? new GitHubRefused(403, "PUT /repos/acme/web-app/pulls/102/merge", "contents=write", "Resource not accessible by integration") : null);

      await f.orchestrator.runUntilIdle();

      expect(f.log.eventsFor(job.job_id).find((e) => e.type === "reverted")?.data).toMatchObject({ revert_pr: 102, merged: false });
      expect(f.log.factoryPause()).toMatchObject({ data: { reason: "github-refused", message: expect.stringContaining("contents=write") } });
    });

    test("a 404 for the merge commit's checks at the post-merge watch waits, rather than pausing the Factory", async () => {
      const { f, sha } = await merged("auto");
      f.pulls.refuse = (what) => (what.startsWith("checks ") ? new GitHubRefused(404, `GET /repos/acme/web-app/commits/${sha}/check-runs`, null, "Not Found") : null);

      await f.orchestrator.runUntilIdle();

      expect(f.log.factoryPauses()).toEqual([]);
    });

    test("after an /approve'd merge in trial, a red run opens the revert PR for you to merge", async () => {
      const { f, job, sha } = await merged("trial");
      f.pulls.checksOf.set(sha, "red");

      await f.orchestrator.runUntilIdle();

      expect(f.log.eventsFor(job.job_id).findLast((e) => e.type === "reverted")).toMatchObject({ data: { merged: false } });
      expect(f.pulls.of("factory/7-revert-101")).toMatchObject({ state: "open", draft: false });
      expect(agentGit(f.remote, "show", "main:built.txt")).toMatch(/^build/);
    });

    test("green ends the watch; no result within 60 minutes ends it too", async () => {
      const green = await merged("auto");
      await green.f.orchestrator.runUntilIdle();
      expect(green.f.log.eventsFor(green.job.job_id).at(-1)).toMatchObject({ type: "checkpoint-evaluated", data: { checkpoint: "after-merge", outcome: "green" } });

      let at = Date.now();
      const slow = await merged("auto", { now: () => new Date(at) });
      slow.f.pulls.checksOf.set(slow.sha, "pending");
      await slow.f.orchestrator.runUntilIdle();
      expect(slow.f.log.eventsFor(slow.job.job_id).at(-1)?.type).toBe("pr-merged");
      at += 61 * 60_000;
      await slow.f.orchestrator.runUntilIdle();
      expect(slow.f.log.eventsFor(slow.job.job_id).at(-1)).toMatchObject({ type: "checkpoint-evaluated", data: { checkpoint: "after-merge", outcome: "timed-out" } });
      slow.f.pulls.checksOf.set(slow.sha, "red");
      await slow.f.orchestrator.runUntilIdle();
      expect(slow.f.log.store.read().some((e) => e.type === "reverted")).toBe(false);
    });
  });

  test("each ending leaves what it should: cancelled closes the PR, takes the ready label off and deletes branches and the Working copy; failed drafts the PR and keeps both", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building, building] }), withAutonomy("trial"));
    f.source.push(approved(7), approved(8));
    await f.orchestrator.runUntilIdle();
    const [seven, eight] = f.log.jobs();

    f.source.push(comment(7, "/cancel"));
    f.log.record({ type: "job-failed", job_id: eight!.job_id, attempt: 1, actor: "orchestrator", data: { reason: "gave up" } });
    await f.orchestrator.runUntilIdle();

    expect(f.log.job(seven!.job_id)?.status).toBe("cancelled");
    expect(f.pulls.of("factory/7")).toMatchObject({ state: "closed" });
    expect(f.pulls.labelsRemoved).toEqual(["7 factory:ready"]);
    expect(remoteHas(f.remote, "refs/heads/factory/7")).toBe(false);
    expect(existsSync(join(f.home, "work", seven!.job_id))).toBe(false);
    expect(f.log.eventsFor(seven!.job_id).filter((e) => e.type === "pr-closed" || e.type === "ready-label-removed").map((e) => [e.type, e.actor])).toEqual([
      ["pr-closed", "orchestrator"],
      ["ready-label-removed", "orchestrator"],
    ]);

    expect(f.log.job(eight!.job_id)?.status).toBe("failed");
    expect(f.pulls.of("factory/8")).toMatchObject({ state: "open", draft: true });
    expect(f.log.eventsFor(eight!.job_id).at(-1)).toMatchObject({ type: "pr-drafted", data: { number: f.pulls.of("factory/8")!.number } });
    expect(remoteHas(f.remote, "refs/heads/factory/8")).toBe(true);
    expect(existsSync(join(f.home, "work", eight!.job_id))).toBe(true);
  });

  test("an ending GitHub can't take now is written once it's back, and only once", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("trial"));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.pulls.down = true;
    f.source.push(comment(7, "/cancel"));
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob().status).toBe("cancelled");
    expect(f.pulls.of("factory/7")?.state).toBe("open");

    f.pulls.down = false;
    await f.orchestrator.runUntilIdle();
    await f.orchestrator.runUntilIdle();

    expect(f.pulls.of("factory/7")?.state).toBe("closed");
    expect(f.pulls.calls.filter((c) => c.startsWith("close"))).toHaveLength(1);
    expect(f.pulls.labelsRemoved).toEqual(["7 factory:ready"]);
  });

  test("while GitHub is down, Stage runs carry on and the merge waits; once it's back, the PR opens and the Job merges", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    f.pulls.down = true;
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.agent.stagesRun()).toEqual(["triage", "build", "review", "security"]);
    expect(f.onlyJob()).toMatchObject({ status: "queued", stage: "security" });
    expect(f.types(f.onlyJob().job_id)).not.toContain("merge-gate-evaluated");

    f.pulls.down = false;
    await f.orchestrator.runUntilIdle();
    expect(f.types(f.onlyJob().job_id).slice(-4)).toEqual(["pr-opened", "merge-gate-evaluated", "checkpoint-evaluated", "pr-merged"]);
  });

  test("a permission GitHub refuses at the Merge gate pauses the Factory, naming the call and the permission; a restart once it's granted carries on", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    const call = "GET /repos/acme/web-app/commits/abc123/status";
    f.pulls.refuse = (what) => (what.startsWith("get ") ? new GitHubRefused(403, call, "statuses=read", "Resource not accessible by integration") : null);
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    const job = f.onlyJob();
    const pause = f.log.factoryPause()!;
    expect(pause).toMatchObject({ type: "factory-paused", data: { reason: "github-refused" } });
    expect(String(pause.data.message)).toContain(call);
    expect(String(pause.data.message)).toContain("statuses=read");
    expect(job).toMatchObject({ status: "paused", reason: "factory-paused" });
    // Said on the Job too, caused by the pause.
    const said = f.log.eventsFor(job.job_id).at(-1)!;
    expect(said).toMatchObject({ type: "checkpoint-evaluated", caused_by: pause.id, data: { checkpoint: "merge-gate", outcome: "github-refused", why: pause.data.message } });

    // Not asked again and again while paused.
    const seen = f.log.store.read().length;
    await f.orchestrator.runUntilIdle();
    expect(f.log.store.read()).toHaveLength(seen);

    // `factory status` says what was refused and what to change, and why the Job is parked.
    const { stdout } = await cli(f.home, "status");
    const lines = stdout.split("\n");
    expect(lines[0]).toContain("The Factory is paused (github-refused): GitHub refused GET /repos/acme/web-app/commits/abc123/status");
    expect(lines[0]).toContain("statuses=read");
    expect(lines[0]).toContain("restart the Factory");
    expect(lines.find((l) => l.startsWith(job.job_id))).toContain("factory-paused: github-refused");

    // Restarted before it's fixed: paused again, but the Job doesn't say it twice.
    await f.orchestrator.start();
    await f.orchestrator.runUntilIdle();
    expect(f.log.factoryPause()).toMatchObject({ data: { reason: "github-refused" } });
    expect(f.log.eventsFor(job.job_id).filter((e) => e.data.outcome === "github-refused")).toHaveLength(1);

    f.pulls.refuse = null;
    await f.orchestrator.start();
    await f.orchestrator.runUntilIdle();
    expect(f.log.factoryPauses()).toEqual([]);
    expect(f.onlyJob().status).toBe("merged");
  });

  test("an outage at the Merge gate (GitHub kept failing) waits quietly: no pause, nothing recorded", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    f.source.push(approved(7));
    let outage = true;
    const get = f.pulls.get.bind(f.pulls);
    f.pulls.get = async (repo, number) => {
      if (outage) throw new GitHubUnavailable("GitHub kept failing: GET /repos/acme/web-app/commits/abc/status → 503.");
      return get(repo, number);
    };

    await f.orchestrator.runUntilIdle();
    const job = f.onlyJob();
    expect(f.log.factoryPauses()).toEqual([]);
    expect(job).toMatchObject({ status: "queued", stage: "security" });
    expect(f.types(job.job_id)).not.toContain("checkpoint-evaluated");

    outage = false;
    await f.orchestrator.runUntilIdle();
    expect(f.onlyJob().status).toBe("merged");
  });

  test("a merge GitHub won't do whatever the head (branch protection) goes to a human instead of being tried again and again", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    f.pulls.refuseMerges = "At least 1 approving review is required.";
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();
    await f.orchestrator.runUntilIdle();

    expect(f.pulls.calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
    expect(f.log.store.read().at(-1)).toMatchObject({ type: "human-requested", data: { cause: "merge-gate", text: "GitHub won't merge #101: At least 1 approving review is required." } });
    expect(f.onlyJob()).toMatchObject({ status: "waiting", reason: "merge-gate" });
  });

  test("a revert GitHub refuses ends the watch, saying so, rather than being asked for every pass", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"));
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const job_id = f.onlyJob().job_id;
    f.pulls.checksOf.set(f.log.eventsFor(job_id).findLast((e) => e.type === "pr-merged")!.data.sha as string, "red");
    f.pulls.refuseOpens = true;

    await f.orchestrator.runUntilIdle();
    await f.orchestrator.runUntilIdle();

    expect(f.pulls.calls.filter((c) => c.startsWith("open factory/7-revert"))).toHaveLength(1);
    expect(f.log.eventsFor(job_id).at(-1)).toMatchObject({ type: "checkpoint-evaluated", data: { checkpoint: "after-merge", outcome: "red", why: expect.stringContaining("GitHub refused the revert PR") } });
  });

  test("a merge the Factory made but died before recording is recorded as its own after a restart", async () => {
    let failMerged = true;
    const wrapStore = (store: JobStore): JobStore => ({
      ...store,
      append: (event) => {
        if (failMerged && event.type === "pr-merged") throw new Error("SQLITE_FULL: database or disk is full");
        return store.append(event);
      },
      get: (id) => store.get(id),
      read: (from, limit) => store.read(from, limit),
      follow: (from, o) => store.follow(from, o),
      transaction: (fn) => store.transaction(fn),
      cursor: (name) => store.cursor(name),
      saveCursor: (name, value) => store.saveCursor(name, value),
      close: () => store.close(),
    });
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"), { wrapStore });
    f.source.push(approved(7));
    await expect(f.orchestrator.runUntilIdle()).rejects.toBeInstanceOf(JobStoreUnwritable);
    expect(f.pulls.of("factory/7")?.state).toBe("merged");
    failMerged = false;

    const restarted = factoryAt(f.home, f.remote, new ScriptedAgent(), { pulls: f.pulls });
    await restarted.orchestrator.start();
    await restarted.orchestrator.runUntilIdle();

    const job = restarted.onlyJob();
    expect(job.status).toBe("merged");
    expect(restarted.log.eventsFor(job.job_id).find((e) => e.type === "pr-merged")).toMatchObject({ actor: "orchestrator", data: { number: 101, sha: f.pulls.of("factory/7")!.mergedAs } });
    expect(f.pulls.calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
  });

  test("a revert the Factory made but died before recording is picked up after a restart, not made twice", async () => {
    let failRed = false;
    const wrapStore = (store: JobStore): JobStore => ({
      ...store,
      append: (event) => {
        if (failRed && event.type === "checkpoint-evaluated" && event.data?.outcome === "red") throw new Error("SQLITE_FULL: database or disk is full");
        return store.append(event);
      },
      get: (id) => store.get(id),
      read: (from, limit) => store.read(from, limit),
      follow: (from, o) => store.follow(from, o),
      transaction: (fn) => store.transaction(fn),
      cursor: (name) => store.cursor(name),
      saveCursor: (name, value) => store.saveCursor(name, value),
      close: () => store.close(),
    });
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), withAutonomy("auto"), { wrapStore });
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    const job_id = f.onlyJob().job_id;
    f.pulls.checksOf.set(f.log.eventsFor(job_id).findLast((e) => e.type === "pr-merged")!.data.sha as string, "red");
    failRed = true;
    await expect(f.orchestrator.runUntilIdle()).rejects.toBeInstanceOf(JobStoreUnwritable);
    expect(f.pulls.of("factory/7-revert-101")?.state).toBe("merged");
    failRed = false;

    const restarted = factoryAt(f.home, f.remote, new ScriptedAgent(), { pulls: f.pulls });
    await restarted.orchestrator.start();
    await restarted.orchestrator.runUntilIdle();

    expect(restarted.log.eventsFor(job_id).filter((e) => e.type === "reverted")).toMatchObject([{ data: { revert_pr: 102, merged: true } }]);
    expect(f.pulls.calls.filter((c) => c.startsWith("open factory/7-revert"))).toHaveLength(1);
    expect(f.pulls.calls.filter((c) => c === "merge 102")).toHaveLength(1);
    expect(remoteHas(f.remote, "refs/heads/factory/7-revert-101")).toBe(false);
  });

  test("a repo's merge_method is how the Factory merges its PRs", async () => {
    const config = withAutonomy("auto").replace("default_pipeline: feature", "default_pipeline: feature\n    merge_method: rebase");
    const f = fakeFactory(new ScriptedAgent({ build: [building] }), config);
    f.source.push(approved(7));

    await f.orchestrator.runUntilIdle();

    expect(f.onlyJob().status).toBe("merged");
    expect(f.pulls.methods).toEqual(["rebase"]);
  });
});
