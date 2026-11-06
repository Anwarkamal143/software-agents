import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FactoryEvent } from "../events/envelope.js";
import { homePaths } from "../home.js";
import type { EventLog } from "../jobs/event-log.js";
import type { JobState } from "../jobs/projection.js";
import type { ArtifactStore } from "../store/artifact-store.js";

/** Deletes Job branches on GitHub. Returns the branches that are gone now (deleted, or already missing). */
export interface BranchDeleter {
  deleteBranches(repo: string, branches: string[]): Promise<string[]>;
}

export interface HousekeepingDeps {
  home: string;
  log: EventLog;
  artifacts: ArtifactStore;
  branches: BranchDeleter;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed Job's Working copies and branches are kept this long, so you can look or retry (ADR 0010). */
const FAILED_KEPT_MS = 7 * DAY_MS;
/** Transcripts and artifacts are kept this long after their Job ends, except Evidence behind a merge (ADR 0009). */
const FILES_KEPT_MS = 30 * DAY_MS;
/** An artifact no event points at yet may be about to be: it is left alone this long. */
const ORPHAN_GRACE_MS = DAY_MS;

const SHA256 = /^[0-9a-f]{64}$/;

const ENDINGS = new Set(["job-failed", "job-cancelled", "pr-merged"]);

/**
 * One housekeeping sweep (ADR 0010), at startup and hourly: Working copies of failed Jobs past
 * 7 days, of ended Jobs and of no Job; Transcripts and artifacts 30 days after their Job ended,
 * except Evidence behind a merge; and Job branches not yet deleted. Records one `housekeeping-ran`.
 */
export async function housekeep({ home, log, artifacts, branches, now = () => new Date() }: HousekeepingDeps): Promise<FactoryEvent> {
  const at = now().getTime();
  const paths = homePaths(home);
  const events = log.store.read();
  const jobs = new Map(log.jobs().map((j) => [j.job_id, j]));
  const endedAt = new Map<string, number>();
  for (const e of events) if (e.job_id && ENDINGS.has(e.type)) endedAt.set(e.job_id, Date.parse(e.at));
  const ended = (job: JobState | undefined) => job !== undefined && (job.status === "merged" || job.status === "failed" || job.status === "cancelled");
  const age = (job_id: string) => at - (endedAt.get(job_id) ?? at);

  /** Working copies: a failed Job's for 7 days; a merged or cancelled Job's, or no Job's, at once. */
  const workGone = (job_id: string) => {
    const job = jobs.get(job_id);
    if (!job) return true;
    if (job.status === "failed") return age(job_id) > FAILED_KEPT_MS;
    return ended(job);
  };
  /** Transcripts: 30 days after the Job ends; a folder of no Job at once. */
  const filesGone = (job_id: string) => {
    const job = jobs.get(job_id);
    return !job || (ended(job) && age(job_id) > FILES_KEPT_MS);
  };

  const working_copies = sweepFolders(paths.work, workGone);
  const transcripts = sweepFolders(paths.transcripts, filesGone);
  const artifactCount = sweepArtifacts(artifacts, paths.artifacts, events, jobs, filesGone, at);
  const branches_deleted = await deleteBranches(events, jobs, branches, (job) => job.status !== "failed" || age(job.job_id) > FAILED_KEPT_MS);

  return log.record({
    type: "housekeeping-ran",
    actor: "orchestrator",
    data: { working_copies, transcripts, artifacts: artifactCount, branches_deleted },
  });
}

/** Deletes each `<dir>/<job_id>` folder `gone` says to. Returns how many went. */
function sweepFolders(dir: string, gone: (job_id: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !gone(entry.name)) continue;
    rmSync(join(dir, entry.name), { recursive: true, force: true });
    count++;
  }
  return count;
}

/**
 * An artifact stays while any Job pointing at it keeps its files, or forever while it is
 * Evidence of a merged Job. One no event points at goes once it's past its grace period.
 */
function sweepArtifacts(store: ArtifactStore, dir: string, events: FactoryEvent[], jobs: Map<string, JobState>, filesGone: (job_id: string) => boolean, at: number): number {
  if (!existsSync(dir)) return 0;
  const pointedAt = new Map<string, Set<string>>();
  const mergedEvidence = new Set<string>();
  for (const e of events) {
    if (!e.job_id) continue;
    for (const sha of hashesIn(e.data)) {
      const set = pointedAt.get(sha) ?? new Set();
      set.add(e.job_id);
      pointedAt.set(sha, set);
    }
    if (e.type === "evidence-recorded" && jobs.get(e.job_id)?.status === "merged") mergedEvidence.add(String(e.data.sha256));
  }
  let count = 0;
  for (const prefix of readdirSync(dir, { withFileTypes: true })) {
    if (!prefix.isDirectory()) continue;
    for (const file of readdirSync(join(dir, prefix.name))) {
      // Only sha256-named files are artifacts; a half-written temp file is left for its writer.
      if (!SHA256.test(file)) continue;
      const path = store.path(file);
      const owners = pointedAt.get(file);
      const gone = owners ? !mergedEvidence.has(file) && [...owners].every(filesGone) : at - statSync(path).mtimeMs > ORPHAN_GRACE_MS;
      if (!gone) continue;
      rmSync(path, { force: true });
      count++;
    }
  }
  return count;
}

/** Every `sha256` value anywhere in event data: how events point at artifacts (ADR 0009). */
function hashesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) hashesIn(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "sha256" && typeof v === "string") out.push(v);
      else hashesIn(v, out);
    }
  }
  return out;
}

/**
 * Branches of ended Jobs that are due to go and that no earlier sweep deleted: a deletion
 * that failed (GitHub down, say) is simply tried again next time.
 */
async function deleteBranches(events: FactoryEvent[], jobs: Map<string, JobState>, deleter: BranchDeleter, due: (job: JobState) => boolean) {
  const done = new Set<string>();
  for (const e of events) {
    if (e.type !== "housekeeping-ran") continue;
    for (const d of (e.data.branches_deleted as { job_id: string; branch: string }[] | undefined) ?? []) done.add(`${d.job_id}\0${d.branch}`);
  }
  const wanted = new Map<string, { repo: string; job_id: string; branch: string }[]>();
  for (const e of events) {
    if (e.type !== "attempt-started" || !e.job_id) continue;
    const job = jobs.get(e.job_id);
    if (!job || !["merged", "cancelled", "failed"].includes(job.status) || !due(job)) continue;
    const branch = String(e.data.branch);
    if (done.has(`${job.job_id}\0${branch}`)) continue;
    wanted.set(job.repo, [...(wanted.get(job.repo) ?? []), { repo: job.repo, job_id: job.job_id, branch }]);
  }
  const deleted: { job_id: string; branch: string }[] = [];
  for (const [repo, list] of wanted) {
    let gone: string[];
    try {
      gone = await deleter.deleteBranches(repo, list.map((b) => b.branch));
    } catch {
      continue; // tried again next sweep
    }
    for (const b of list) if (gone.includes(b.branch)) deleted.push({ job_id: b.job_id, branch: b.branch });
  }
  return deleted;
}
