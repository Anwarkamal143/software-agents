import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { housekeep, type BranchDeleter } from "../src/housekeeping/housekeeping.js";
import { homePaths } from "../src/home.js";
import { EventLog } from "../src/jobs/event-log.js";
import { ArtifactStore } from "../src/store/artifact-store.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { tmpHome } from "./helpers/tmp.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

/** Records a branch deletion instead of pushing; `failing` branches can't be deleted. */
class FakeBranches implements BranchDeleter {
  deleted: [string, string][] = [];
  failing = new Set<string>();
  async deleteBranches(repo: string, branches: string[]) {
    const done = branches.filter((b) => !this.failing.has(b));
    for (const b of done) this.deleted.push([repo, b]);
    return done;
  }
}

function setup() {
  const home = tmpHome();
  const log = new EventLog(openSqliteJobStore(join(home, "factory.db")));
  const artifacts = new ArtifactStore(home);
  const paths = homePaths(home);
  const branches = new FakeBranches();

  /** A Job approved long ago with one Attempt, ended with `ending` at `endedAt` (or still live). */
  const job = (job_id: string, issue: number, ending: "job-failed" | "job-cancelled" | "pr-merged" | null, endedAt: string, refs: { evidence?: string; output?: string } = {}) => {
    log.record({ type: "job-approved", job_id, actor: "human:alice", at: daysAgo(90), data: { repo: "acme/web-app", issue } });
    log.record({ type: "attempt-started", job_id, attempt: 1, actor: "orchestrator", at: daysAgo(90), data: { branch: `factory/${issue}`, base: "abc" } });
    if (refs.output) {
      log.record({ type: "stage-started", job_id, attempt: 1, stage_run_id: `run-${issue}`, actor: "orchestrator", at: daysAgo(90), data: { stage: "verify" } });
      log.record({ type: "stage-passed", job_id, attempt: 1, stage_run_id: `run-${issue}`, actor: "stage:verify", at: daysAgo(90), data: { stage: "verify", output: { sha256: refs.output, size: 1 } } });
    }
    if (refs.evidence) log.record({ type: "evidence-recorded", job_id, attempt: 1, actor: "orchestrator", at: daysAgo(90), data: { head: "def", sha256: refs.evidence, size: 1 } });
    if (ending) log.record({ type: ending, job_id, attempt: 1, actor: "orchestrator", at: endedAt, data: ending === "job-failed" ? { reason: "x" } : {} });
    mkdirSync(join(home, "work", job_id, "a1", "repo"), { recursive: true });
    mkdirSync(join(paths.transcripts, job_id), { recursive: true });
    writeFileSync(join(paths.transcripts, job_id, "run.ndjson"), "{}\n");
  };
  /** An artifact file written `age` days ago. */
  const artifact = (content: string, age: number) => {
    const ref = artifacts.put(content);
    const t = new Date(NOW.getTime() - age * DAY);
    utimesSync(artifacts.path(ref.sha256), t, t);
    return ref.sha256;
  };
  const sweep = () => housekeep({ home, log, artifacts, branches, now: () => NOW });
  const work = (job_id: string) => existsSync(join(home, "work", job_id));
  const transcript = (job_id: string) => existsSync(join(paths.transcripts, job_id));
  const kept = (sha: string) => existsSync(artifacts.path(sha));
  return { home, log, job, artifact, sweep, work, transcript, kept, branches };
}

describe("Housekeeping", () => {
  test("deletes only what is past its retention, and records one housekeeping-ran event", async () => {
    const h = setup();
    const oldMergedEvidence = h.artifact("merged evidence", 60);
    const oldFailedOutput = h.artifact("old failed output", 60);
    const recentFailedOutput = h.artifact("recent failed output", 60);
    const liveOutput = h.artifact("live output", 60);
    const orphanOld = h.artifact("nobody points at this", 3);
    const orphanNew = h.artifact("just written", 0);

    h.job("live", 1, null, "");
    h.job("failed-recent", 2, "job-failed", daysAgo(3), { output: recentFailedOutput });
    h.job("failed-old", 3, "job-failed", daysAgo(8));
    h.job("failed-ancient", 4, "job-failed", daysAgo(31), { output: oldFailedOutput });
    h.job("merged-ancient", 5, "pr-merged", daysAgo(40), { evidence: oldMergedEvidence });
    h.job("cancelled", 6, "job-cancelled", daysAgo(1));
    h.job("live-2", 7, null, "", { output: liveOutput });
    mkdirSync(join(h.home, "work", "no-such-job"), { recursive: true });

    const ran = await h.sweep();

    // Working copies: live and recently failed stay; failed past 7 days, merged, cancelled and orphans go.
    expect(["live", "failed-recent", "live-2"].map(h.work)).toEqual([true, true, true]);
    expect(["failed-old", "failed-ancient", "merged-ancient", "cancelled", "no-such-job"].map(h.work)).toEqual([false, false, false, false, false]);
    // Transcripts: kept 30 days after a Job ends.
    expect(["live", "failed-recent", "failed-old", "cancelled"].map(h.transcript)).toEqual([true, true, true, true]);
    expect(["failed-ancient", "merged-ancient"].map(h.transcript)).toEqual([false, false]);
    // Artifacts: Evidence behind a merge stays; others go 30 days after their Job ends; old orphans go.
    expect([oldMergedEvidence, recentFailedOutput, liveOutput, orphanNew].map(h.kept)).toEqual([true, true, true, true]);
    expect([oldFailedOutput, orphanOld].map(h.kept)).toEqual([false, false]);
    // Branches: merged and cancelled at once; failed after 7 days.
    expect(h.branches.deleted.map(([, b]) => b).sort()).toEqual(["factory/3", "factory/4", "factory/5", "factory/6"]);

    expect(h.log.store.read().filter((e) => e.type === "housekeeping-ran")).toEqual([ran]);
    expect(ran).toMatchObject({ job_id: null, actor: "orchestrator", data: { working_copies: 5, transcripts: 2, artifacts: 2 } });
  });

  test("a branch deletion that failed is retried at the next sweep, and one that worked isn't repeated", async () => {
    const h = setup();
    h.job("cancelled", 6, "job-cancelled", daysAgo(1));
    h.branches.failing.add("factory/6");
    await h.sweep();
    expect(h.branches.deleted).toEqual([]);

    h.branches.failing.clear();
    await h.sweep();
    await h.sweep();

    expect(h.branches.deleted).toEqual([["acme/web-app", "factory/6"]]);
  });
});
