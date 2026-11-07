import picomatch from "picomatch";
import { ulid } from "ulid";
import type { AgentAdapter, MeasuredFacts, RateLimitInfo, RunErrorReason, SessionResume } from "../agents/adapter.js";
import type { ConfigHolder } from "../config/holder.js";
import { resolve, type Resolution, type ResolvedStage } from "../config/resolve.js";
import type { MergeMethod, StageCondition } from "../config/types.js";
import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { EventLog } from "../jobs/event-log.js";
import type { JobState } from "../jobs/projection.js";
import type { Mirror } from "../mirror/mirror.js";
import { cleanAgentText } from "../mirror/clean.js";
import type { PullRequest, PullRequests } from "../github/pulls.js";
import { GitHubError, GitHubUnavailable } from "../github/client.js";
import { approvedAtMergeGate, checksToRerun, decideMerge, evaluateMergeGate, mergeGateEvents, selfEditedChecks, stagesAtGate, type MergeDecision } from "../policies/merge-gate.js";
import { matchRiskRules } from "../policies/risk.js";
import type { Finding } from "../stages/result.js";
import { FACTORY_MARKER } from "../humans/commands.js";
import { budgetAfterStageRun, budgetBeforeStageRun, spentToday, type BudgetHit } from "../policies/budgets.js";
import type { Checkpoint } from "../policies/checkpoint.js";
import type { PrePushChecks } from "../repos/prepush.js";
import type { Clones, Rebase, WorkingCopy } from "../repos/clones.js";
import { issueHash, SourceCredentialsRefused, type Source, type SourceItem } from "../source/source.js";
import { renderBrief, renderHumanInput, type StageBrief } from "../stages/brief.js";
import { parseReplyCommand } from "../humans/commands.js";
import type { Notifier } from "../humans/notify.js";
import { recordMalformedReply, recordReply } from "../humans/replies.js";
import type { SecretStore } from "../secrets/keychain.js";
import { SandboxUnavailable, type CheckRun, type CheckRunner } from "../stages/check-runner.js";
import { parseStageResult, STAGE_RESULT_SCHEMA, type StageResult } from "../stages/result.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { attemptProgress, type AttemptProgress, type PendingAnswer } from "./progress.js";
import { GIVE_UP_CAUSES, isLive, STAGE_RUN_ENDINGS } from "../jobs/endings.js";
import { afterRunError, retryRun } from "./retries.js";
import { MAX_GUARD_DENIALS, SessionWatch, type DenialTally, type RunEnvelope } from "./session-watch.js";

export interface OrchestratorDeps {
  log: EventLog;
  config: ConfigHolder;
  source: Source;
  agent: AgentAdapter;
  checks: CheckRunner;
  mirrors: Mirror[];
  /** Every PR the Factory opens, merges or reverts goes through here. */
  pulls: PullRequests;
  artifacts: ArtifactStore;
  /** Trusted clones and Working copies (ADR 0008). */
  clones: Clones;
  prePush: PrePushChecks;
  /** Where check secrets are read from, by the Orchestrator alone. */
  secrets: SecretStore;
  /** What time it is; the daily Budget counts from local midnight. */
  now?: () => Date;
  /** Tells whoever is at this machine about each Human request. */
  notifier?: Notifier;
  /** Stuck detection (ADR 0010). Defaults: 10 minutes idle; the wall-clock is the Stage-run Budget's minutes. */
  limits?: { idleMs?: number; wallClockMs?: number };
  /** Waits between transient retries. */
  sleep?: (ms: number) => Promise<void>;
}

/** The Job store can't be written: nothing can be decided, so the Orchestrator stops (ADR 0010). */
export class JobStoreUnwritable extends Error {
  override name = "JobStoreUnwritable";
  constructor(cause: unknown) {
    super(`The Job store can't be written, so the Orchestrator stops: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** The approved issue, as recorded on `job-approved`. */
interface Approval {
  title: string;
  body: string;
  labels: string[];
}

type StageOutcome =
  | { kind: "result"; result: StageResult; facts: Partial<MeasuredFacts>; extra?: Record<string, unknown>; session_id?: string }
  | { kind: "error"; reason: RunErrorReason | "invalid-result"; message: string; facts: Partial<MeasuredFacts>; session_id?: string; where?: string }
  /** A Pre-push check failed: already recorded, and the Job is waiting. */
  | { kind: "stopped" }
  /** The Orchestrator is stopping: nothing more is recorded. */
  | { kind: "abandoned" }
  /** The run was cut off for something outside the Stage: it ends without a Verdict and isn't counted. */
  | { kind: "interrupted"; reason: "guard-denials" | "plan-limit"; message: string; session_id?: string }
  /** A Factory fault (ADR 0010): the run ends without a Verdict and the whole Factory pauses. */
  | { kind: "fault"; reason: "sandbox-unavailable" | "check-secret-missing" | "sign-in-mismatch"; message: string };


/** Everything one step of one Job is decided from. */
interface StepContext {
  job: JobState;
  approval: Approval;
  resolution: Resolution;
  progress: AttemptProgress;
  /** The current Attempt's events, in seq order. */
  events: FactoryEvent[];
  wc: WorkingCopy;
  /** The Job's latest event: whatever this step does, it happens because of it. */
  cause: string | null;
  /** A Reply command recorded since the Job's last step, which this step acts on. */
  reply: { answered: FactoryEvent; request: FactoryEvent | undefined } | null;
}

/**
 * What a queued Job does next: something instant, or a Stage run that needs a free slot. An
 * instant step says whether it changed anything: one that didn't (the Merge gate waiting on
 * GitHub, say) is looked at again on the next pass, not straight away.
 */
type Plan = { kind: "instant"; run: () => Promise<boolean> } | { kind: "stage-run"; repoLimit: number; run: () => Promise<void> };

/**
 * Owns Job state, Stage order and every git and GitHub write (ADR 0001). Each step is
 * decided from the Event log and config alone; Verdicts only route (ADR 0003).
 */
export class Orchestrator {
  /** The poll in flight, if any. */
  private polling: Promise<void> | null = null;
  /** Aborted once the Orchestrator must stop: every session is cut off and nothing new starts. */
  private readonly stopping = new AbortController();
  private readonly sessions: SessionWatch;
  /** One Merge gate step at a time per Target repo: rebase, re-verify and merge never interleave (ADR 0008). */
  private readonly mergeLocks = new Map<string, Promise<unknown>>();
  /** Jobs whose merge GitHub refused in this pass: the gate re-runs, but merges again only next pass. */
  private refusedThisPass = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.sessions = new SessionWatch({
      agent: deps.agent,
      record: (event) => this.record(event),
      planLimitHit: (info, caused_by) => this.planLimitHit(info, caused_by),
      stopping: this.stopping.signal,
      ...(deps.limits && { limits: deps.limits }),
      ...(deps.sleep && { sleep: deps.sleep }),
    });
  }

  /**
   * Polls the Source once, then keeps Jobs moving until none can without something new
   * happening. Stage runs go in parallel up to `max_running`, Factory-wide and per repo;
   * queued Jobs start resumed first, then first come, first served by Job approval (ADR 0008).
   */
  async runUntilIdle(): Promise<void> {
    const running = new Map<string, { repo: string; done: Promise<void> }>();
    // A Stage run that throws ends this pass: the others finish (or, if the Job store is
    // unwritable, are cut off), and the first error is rethrown once nothing is running.
    const faults: unknown[] = [];
    this.refusedThisPass = new Set();
    const fault = (err: unknown) => {
      if (err instanceof JobStoreUnwritable) this.stopping.abort();
      faults.push(err);
    };
    try {
      await this.poll();
      await this.remind();
      await this.watchMerges();
    } catch (err) {
      fault(err);
    }
    for (;;) {
      let moved = false;
      // After a fault, or once stopping, start nothing new; only let what's running finish.
      const halted = faults.length > 0 || this.stopping.signal.aborted;
      if (!halted) await this.releasePlanLimit().catch(fault);
      for (const job of halted ? [] : this.queue(running)) {
        let plan: Plan | null;
        let changed = false;
        try {
          plan = await this.plan(job);
          if (plan?.kind === "instant") changed = await plan.run();
        } catch (err) {
          fault(err);
          break;
        }
        if (!plan) continue;
        if (plan.kind === "instant") {
          if (!changed) continue;
          moved = true;
          break; // the queue may look different now
        }
        const inRepo = [...running.values()].filter((r) => r.repo === job.repo).length;
        if (running.size >= this.deps.config.current.max_running || inRepo >= plan.repoLimit) continue;
        const done = plan
          .run()
          .catch(fault)
          .finally(() => running.delete(job.job_id));
        running.set(job.job_id, { repo: job.repo, done });
        moved = true;
      }
      if (moved) continue;
      if (!running.size) {
        if (faults.length) throw faults[0];
        return;
      }
      await Promise.race([...running.values()].map((r) => r.done));
    }
  }

  /**
   * Startup after the Event log has been replayed (ADR 0010): every Stage run still marked
   * running was cut off when the last Orchestrator died, so it is recorded as interrupted,
   * naming its session if it reported one; the next run resumes that session once, or reruns.
   * Jobs parked by the plan limit stay parked until it resets.
   */
  async start(): Promise<void> {
    const started = await this.record({ type: "factory-started", actor: "orchestrator" });
    // Running Jobs, and Jobs whose Stage run was held for re-approval when the Orchestrator died.
    for (const job of this.deps.log.jobs().filter((j) => j.status === "running" || (j.status === "waiting" && j.reason === "reapproval"))) {
      const events = this.deps.log.eventsFor(job.job_id);
      const run = events.findLast((e) => e.type === "stage-started" || e.type === "stage-resumed");
      if (!run || events.some((e) => e.stage_run_id === run.stage_run_id && STAGE_RUN_ENDINGS.has(e.type))) continue;
      const reported = events.findLast((e) => e.type === "session-started" && e.stage_run_id === run.stage_run_id)?.data.session_id;
      const session_id = reported ?? (run.type === "stage-resumed" ? run.data.session_id : undefined);
      await this.record({
        job_id: job.job_id,
        attempt: run.attempt,
        stage_run_id: run.stage_run_id,
        actor: "orchestrator",
        caused_by: started.id,
        type: "stage-interrupted",
        data: { stage: String(run.data.stage), ...(typeof session_id === "string" && { session_id }) },
      });
    }
  }

  /**
   * Stops at once, as a kill would: every session is cut off and nothing more is recorded for
   * it. The next `start()` finds those Stage runs unfinished.
   */
  stop(): void {
    this.stopping.abort();
  }

  /** A plan limit parks the Factory until its reset time (ADR 0010); then Jobs carry on. */
  private async releasePlanLimit(): Promise<void> {
    const pause = this.deps.log.factoryPause();
    if (pause?.type !== "plan-limit-hit") return;
    const resetsAt = typeof pause.data.resets_at === "string" ? Date.parse(pause.data.resets_at) : Date.parse(pause.at) + PLAN_LIMIT_FALLBACK_MS;
    if (this.now().getTime() < resetsAt) return;
    await this.record({ type: "plan-limit-reset", actor: "orchestrator", caused_by: pause.id });
  }

  /** When the plan limit is reached, or past 90% of it, no new Stage run starts until it resets. */
  private async planLimitHit(info: RateLimitInfo, caused_by: string | null | undefined): Promise<void> {
    if (this.deps.log.factoryPause()?.type === "plan-limit-hit") return;
    await this.record({
      type: "plan-limit-hit",
      actor: "orchestrator",
      caused_by: caused_by ?? null,
      data: { status: info.status, ...(info.resets_at && { resets_at: info.resets_at }), ...(info.utilization !== undefined && { utilization: info.utilization }) },
    });
  }

  private queue(running: Map<string, unknown>): JobState[] {
    const queued = this.deps.log.jobs().filter((j) => j.status === "queued" && !running.has(j.job_id));
    // Array.prototype.sort is stable, so approval order holds within each group.
    return queued.sort((a, b) => Number(b.resumed) - Number(a.resumed));
  }

  /**
   * Polls the Source once and admits what it reports, from the cursor kept in the Job store,
   * so a restart catches up on what happened while the Factory was off. Safe to call while
   * Stage runs go on (the foreground loop polls every 60s); overlapping calls share one poll.
   */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => (this.polling = null));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const store = this.deps.log.store;
    let polled: Awaited<ReturnType<Source["poll"]>>;
    try {
      polled = await this.deps.source.poll(store.cursor(SOURCE_CURSOR));
    } catch (err) {
      if (!(err instanceof SourceCredentialsRefused)) throw err;
      // A Factory fault: no new Stage run starts until the credentials work again (ADR 0010).
      if (this.deps.log.factoryPause()?.data.reason !== SOURCE_CREDENTIALS) {
        await this.record({ type: "factory-paused", actor: "orchestrator", data: { reason: SOURCE_CREDENTIALS, message: err.message } });
      }
      return;
    }
    const pause = this.deps.log.factoryPause();
    if (pause?.type === "factory-paused" && pause.data.reason === SOURCE_CREDENTIALS) {
      await this.record({ type: "factory-resumed", actor: "orchestrator", caused_by: pause.id });
    }
    const { items, cursor } = polled;
    for (const item of items) await this.admit(item);
    try {
      store.saveCursor(SOURCE_CURSOR, cursor);
    } catch (err) {
      throw new JobStoreUnwritable(err);
    }
  }

  private async admit(item: SourceItem): Promise<void> {
    switch (item.kind) {
      case "comment":
        return this.reply(item);
      case "approved":
        return this.approved(item);
      case "edited":
        return this.edited(item);
      case "unapproved":
      case "closed": {
        const live = this.liveJob(item.repo, item.issue);
        // Only someone on `humans` can end a Job, whatever GitHub lets them do to the issue.
        if (!live || !this.deps.config.current.humans.includes(item.by)) return;
        const reason = item.kind === "unapproved" ? "ready label removed" : `issue closed by ${item.by}`;
        await this.record({ type: "job-cancelled", job_id: live.job_id, attempt: live.attempt, actor: `human:${item.by}`, data: { reason } });
        await this.cleanUp(live);
        return;
      }
      case "pr-merged":
      case "pr-closed": {
        const job = this.jobOnBranch(item.repo, item.branch);
        if (!job || !isLive(job)) return;
        if (item.kind === "pr-closed") return void (await this.record({ ...jobEvent(job, null), actor: `human:${item.by}`, type: "pr-closed", data: { number: item.pr } }));
        // You merged the Job's PR yourself (Autonomy off): the Job is merged.
        await this.record({ ...jobEvent(job, null), actor: `human:${item.by}`, type: "pr-merged", data: { number: item.pr, by: item.by } });
        await this.cleanUp(job);
        return;
      }
      case "reopened":
        // Nothing starts until an allowed person applies the ready label again.
        return;
    }
  }

  private liveJob(repo: string, issue: number): JobState | undefined {
    return this.deps.log.jobs().find((j) => j.repo === repo && j.issue === issue && isLive(j));
  }

  /** The Job one of whose Attempts runs on `branch`. */
  private jobOnBranch(repo: string, branch: string): JobState | undefined {
    const started = this.deps.log.store.read().findLast((e) => e.type === "attempt-started" && e.data.branch === branch && this.deps.log.job(e.job_id!)?.repo === repo);
    return started?.job_id ? this.deps.log.job(started.job_id) : undefined;
  }

  /** Job approval: only from someone on `humans`, whatever the Source says (ADR 0007). */
  private async approved(item: Extract<SourceItem, { kind: "approved" }>): Promise<void> {
    if (!this.deps.config.current.humans.includes(item.by)) return;
    const issue = item.issue.number;
    if (this.liveJob(item.repo, issue)) return; // One live Job per issue.
    // Re-labelling a failed or cancelled Job starts its next Attempt; after a merge, a new Job.
    const ended = this.deps.log.jobs().findLast((j) => j.repo === item.repo && j.issue === issue);
    if (ended && (ended.status === "failed" || ended.status === "cancelled")) {
      await this.record({
        type: "job-retried",
        job_id: ended.job_id,
        attempt: ended.attempt,
        actor: `human:${item.by}`,
        data: { title: item.issue.title, body: item.issue.body, labels: item.labels },
      });
      return;
    }
    const branch = attemptBranch(issue, this.attemptsOfIssue(item.repo, issue) + 1);
    const job_id = ulid();
    const approval = await this.record({
      type: "job-approved",
      job_id,
      actor: `human:${item.by}`,
      data: { repo: item.repo, issue, title: item.issue.title, body: item.issue.body, labels: item.labels },
    });
    const wc = await this.deps.clones.startAttempt({ repo: item.repo, job_id, attempt: 1, branch });
    await this.record({ type: "attempt-started", job_id, attempt: 1, actor: "orchestrator", caused_by: approval.id, data: { branch, base: wc.base } });
  }

  /**
   * The issue's text changed after approval (ADR 0007): an edit by someone on `humans` counts as
   * re-approval; anyone else's sends the Job to waiting with a Human request, holding the result
   * of a Stage run still going.
   */
  private async edited(item: Extract<SourceItem, { kind: "edited" }>): Promise<void> {
    const live = this.liveJob(item.repo, item.issue.number);
    if (!live) return;
    const events = this.deps.log.eventsFor(live.job_id);
    const known = events.filter((e) => e.type === "issue-edited").map((e) => e.data.hash);
    if (issueHash(approvalOf(events)) === item.hash || known.at(-1) === item.hash) return;
    const allowed = item.by !== null && this.deps.config.current.humans.includes(item.by);
    const actor = item.by ? (`human:${item.by}` as const) : ("orchestrator" as const);
    const edit = await this.record({
      ...jobEvent(live, null),
      actor,
      type: "issue-edited",
      data: { hash: item.hash, title: item.issue.title, body: item.issue.body, allowed, ...(item.by && { by: item.by }) },
    });
    if (allowed) return;
    const needed = await this.record({ ...jobEvent(live, edit.id), type: "job-reapproval-needed", data: item.by ? { editor: item.by } : {} });
    const who = item.by ?? "Someone GitHub doesn't name";
    await this.askHuman(this.context(this.deps.log.job(live.job_id)!), { kind: "approval", cause: "reapproval", text: `${who} edited the issue after it was approved, and isn't on humans.` }, needed.id);
  }

  /** A comment on a Job's issue: a Reply command is recorded, or logged as ignored; anything else is discussion. */
  private async reply(item: Extract<SourceItem, { kind: "comment" }>): Promise<void> {
    const parsed = parseReplyCommand(item.comment.body);
    if (parsed.kind === "none" || parsed.kind === "factory") return;
    const live = this.deps.log.jobs().find((j) => j.repo === item.repo && j.issue === item.issue && isLive(j));
    if (!live) return;
    const { comment } = item;
    const reply = { job_id: live.job_id, channel: "github" as const, by: comment.by, created_at: comment.created_at, comment_id: comment.id };
    const humans = this.deps.config.current.humans;
    if (parsed.kind === "malformed") return void (await this.mirror(recordMalformedReply(this.deps.log, reply, parsed.why, humans)));
    // Write access is asked only about people on `humans`; nobody else's reply counts anyway.
    const writeAccess = humans.includes(comment.by) && (await this.deps.source.hasWriteAccess(item.repo, comment.by));
    const outcome = recordReply(this.deps.log, { ...reply, command: parsed.command }, { humans, writeAccess });
    await this.mirror(outcome.event);
  }

  /** One reminder per Human request still unanswered after three days. */
  private async remind(): Promise<void> {
    const now = this.now().getTime();
    for (const job of this.deps.log.jobs().filter((j) => j.status === "waiting")) {
      const events = this.deps.log.eventsFor(job.job_id);
      const request = events.findLast((e) => e.type === "human-requested");
      if (!request || now - Date.parse(request.at) < REMIND_AFTER_MS) continue;
      if (events.some((e) => e.type === "human-reminded" && e.data.request === request.id)) continue;
      await this.record({ ...jobEvent(job, request.id), type: "human-reminded", data: { request: request.id } });
    }
  }

  /**
   * The checkpoint after a merge (ADR 0004): for `post_merge_watch_minutes` after the Factory
   * merges, it looks at the default branch's first CI run, the one on the merge commit. Green, or
   * no result in time, ends the watch; red opens a revert PR, merged by the Factory in auto and left
   * for you otherwise. The Mirror reopens the issue with the reason. No new Job starts: only an
   * allowed person's ready label approves work (ADR 0007).
   */
  private async watchMerges(): Promise<void> {
    for (const job of this.deps.log.jobs().filter((j) => j.status === "merged")) {
      const events = this.deps.log.eventsFor(job.job_id);
      const merged = events.findLast((e) => e.type === "pr-merged");
      // Only the Factory's own merges: yours are yours to watch.
      if (merged?.actor !== "orchestrator" || typeof merged.data.sha !== "string") continue;
      if (events.some((e) => e.seq > merged.seq && e.type === "checkpoint-evaluated" && e.data.checkpoint === "after-merge")) continue;
      const approval = approvalOf(events);
      const { policies, mergeMethod } = resolve(this.deps.config.current, { repo: job.repo, labels: approval.labels });
      const minutes = policies.post_merge_watch_minutes;
      if (!minutes) continue;
      const sha = merged.data.sha;
      let checks;
      try {
        checks = await this.deps.pulls.commitChecks(job.repo, sha);
      } catch (err) {
        if (gitHubFailed(err)) continue;
        throw err;
      }
      const after = { ...jobEvent(job, merged.id), type: "checkpoint-evaluated" } as const;
      if (checks === "green") {
        await this.record({ ...after, data: { checkpoint: "after-merge", outcome: "green", why: `CI passed on ${sha.slice(0, 12)}` } });
      } else if (checks === "red") {
        await this.revert(job, Number(merged.data.number), sha, approval.title, policies.autonomy === "auto" ? mergeMethod : null, merged.id);
      } else if (this.now().getTime() - Date.parse(merged.at) > minutes * 60_000) {
        await this.record({ ...after, data: { checkpoint: "after-merge", outcome: "timed-out", why: `no CI result on ${sha.slice(0, 12)} within ${minutes} minutes` } });
      }
    }
  }

  /**
   * Reverts the merge on a branch the Factory names and pushes itself, opens its PR, and in auto
   * merges it, exactly at the commit pushed. Nothing is recorded until then: a restart finds the
   * same branch and PR again, and GitHub being down just means trying again next pass.
   */
  /** `mergeWith` is how to merge the revert PR, in auto; null leaves it for you. */
  private async revert(job: JobState, number: number, sha: string, title: string, mergeWith: MergeMethod | null, caused_by: string): Promise<void> {
    const why = `CI on the default branch went red at ${sha.slice(0, 12)} after #${number} merged.`;
    const red = (more = "") => ({ ...jobEvent(job, caused_by), type: "checkpoint-evaluated", data: { checkpoint: "after-merge", outcome: "red", why: `${why}${more}` } }) as const;
    const branch = `factory/${job.issue}-revert-${number}`;
    const head = await this.deps.clones.pushRevert(job.repo, sha, branch);
    // Later commits touched the same lines: a human reverts it.
    if (!head) return void (await this.record(red(" It doesn't revert cleanly, so the Factory opened no revert PR.")));
    let revert: { number: number };
    let merged = false;
    try {
      const { defaultBranch } = await this.deps.clones.trustedClone(job.repo);
      revert =
        (await this.deps.pulls.find(job.repo, branch)) ??
        (await this.deps.pulls.open(job.repo, {
          branch,
          base: defaultBranch,
          draft: false,
          title: `Revert "${cleanAgentText(title, MAX_PR_TITLE - 20)}" (#${number})`,
          body: [FACTORY_MARKER, why, "", `Opened by the Factory for Job \`${job.job_id}\`; its status is kept on #${job.issue}.`, ""].join("\n"),
        }));
    } catch (err) {
      // Down: try again next pass. Refused outright: say so and end the watch, rather than ask GitHub every minute.
      if (err instanceof GitHubUnavailable) return;
      if (!(err instanceof GitHubError)) throw err;
      return void (await this.record(red(` GitHub refused the revert PR: ${err.message}`)));
    }
    if (mergeWith) {
      try {
        // Merged already by a Factory that died before recording it; otherwise only at the commit the
        // Factory pushed, never whatever someone else put on the branch since.
        const state = await this.deps.pulls.get(job.repo, revert.number);
        merged = state.state === "merged" || (state.head === head && (await this.deps.pulls.merge(job.repo, revert.number, { sha: head, title: `Revert #${number}`, method: mergeWith })).merged);
      } catch (err) {
        // The revert PR stands open for you; the watch is over either way.
        if (!gitHubFailed(err)) throw err;
      }
    }
    const checked = await this.record(red());
    await this.record({ ...jobEvent(job, checked.id), type: "reverted", data: { revert_pr: revert.number, merged, why } });
    // Only once recorded: until then, the branch is how a restart finds this revert again.
    if (merged) await this.deps.clones.deleteBranches(job.repo, [branch]).catch(() => null);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async plan(job: JobState): Promise<Plan | null> {
    // Edits to factory.yaml apply at the next Stage run (ADR 0005).
    if (this.deps.config.refresh().changed) {
      await this.record({ type: "config-reloaded", actor: "orchestrator", data: { config_hash: this.deps.config.hash } });
    }
    const retried = pendingRetry(this.deps.log.eventsFor(job.job_id));
    if (retried) return instant(() => this.nextAttempt(job, retried));
    const ctx = this.context(job);
    const base = { job_id: job.job_id, attempt: job.attempt, caused_by: ctx.cause };
    const acting = ctx.reply && this.actOnReply(ctx, ctx.reply.answered, ctx.reply.request);
    if (acting) return acting;

    if (ctx.resolution.errors.length) {
      return instant(() => this.askHuman(ctx, { kind: "question", cause: "cannot-start", text: ctx.resolution.errors.join("\n") }, ctx.cause));
    }
    const stage = ctx.resolution.stages[ctx.progress.next];
    if (!stage) {
      // After a rebase, the Check Stages run again on the new head before the gate decides (ADR 0004).
      const rerun = checksToRerun(ctx.events, ctx.resolution.stages, ctx.progress.pushedHead ?? ctx.wc.base)[0];
      const check = rerun && ctx.resolution.stages.find((s) => s.id === rerun);
      if (check) return { kind: "stage-run", repoLimit: ctx.resolution.maxRunning, run: () => this.runStage(ctx, check) };
      return { kind: "instant", run: () => this.inMergeLock(job.repo, () => this.mergeGate(ctx)) };
    }
    if (stage.when && !conditionHolds(stage.when, ctx.approval.labels, ctx.progress.filesChanged)) {
      return instant(() => this.record({ ...base, type: "stage-skipped", actor: "orchestrator", data: { stage: stage.id, why: describeCondition(stage.when!) } }));
    }
    // Checkpoint before a Stage run: the soft Budgets. A Stage run already going finishes (ADR 0004).
    const hit = this.softBudgetHit(job, ctx.resolution);
    if (hit) return instant(() => this.budgetExceeded(job, hit, "before-stage-run", ctx.cause));
    return { kind: "stage-run", repoLimit: ctx.resolution.maxRunning, run: () => this.runStage(ctx, stage) };
  }

  /** Every Attempt any Job of this issue has had: each gets its own branch, even across Jobs. */
  private attemptsOfIssue(repo: string, issue: number): number {
    return this.deps.log.jobs().filter((j) => j.repo === repo && j.issue === issue).reduce((n, j) => n + j.attempt, 0);
  }

  /** The Attempt a human asked for: a fresh Working copy on its own branch from the default branch. */
  private async nextAttempt(job: JobState, retried: FactoryEvent): Promise<void> {
    const attempt = job.attempt + 1;
    const branch = attemptBranch(job.issue, this.attemptsOfIssue(job.repo, job.issue) + 1);
    const wc = await this.deps.clones.startAttempt({ repo: job.repo, job_id: job.job_id, attempt, branch });
    await this.record({ type: "attempt-started", job_id: job.job_id, attempt, actor: "orchestrator", caused_by: retried.id, data: { branch, base: wc.base } });
  }

  private softBudgetHit(job: JobState, resolution: Resolution): BudgetHit | null {
    const daySpent = spentToday(this.deps.log.store.read(), this.now());
    return budgetBeforeStageRun({ budgets: resolution.policies.budgets, jobSpent: job.cost_usd, daySpent });
  }

  /** A passed Budget sends the Job to paused (budget). */
  private budgetExceeded(job: JobState, hit: BudgetHit, checkpoint: Extract<Checkpoint, "before-stage-run" | "after-stage-result">, caused_by: string | null) {
    return this.record({ ...jobEvent(job, caused_by), type: "budget-exceeded", data: { ...hit, checkpoint } });
  }

  private context(job: JobState): StepContext {
    const events = this.deps.log.eventsFor(job.job_id);
    const approval = approvalOf(events);
    const resolution = resolve(this.deps.config.current, { repo: job.repo, labels: approval.labels });
    const attemptEvents = events.filter((e) => e.attempt === job.attempt);
    const started = attemptEvents.find((e) => e.type === "attempt-started")!;
    const wc = this.deps.clones.workingCopy({
      repo: job.repo,
      job_id: job.job_id,
      attempt: job.attempt,
      branch: String(started.data.branch),
      base: String(started.data.base),
    });
    const progress = attemptProgress(attemptEvents, resolution.stages.map((s) => s.id));
    const cause = events.findLast((e) => !NOT_CAUSES.has(e.type))?.id ?? null;
    return { job, approval, resolution, progress, events: attemptEvents, wc, cause, reply: pendingReply(events) };
  }

  /**
   * The step a recorded Reply command calls for, or null when the Job just carries on (an
   * answer resumes the asking Stage; an `/approve` lets the Pipeline continue). Free text
   * only ever travels as data (ADR 0006).
   */
  private actOnReply(ctx: StepContext, answered: FactoryEvent, request: FactoryEvent | undefined): Plan | null {
    const { job, progress, resolution } = ctx;
    const envelope = { job_id: job.job_id, attempt: job.attempt, actor: answered.actor, caused_by: answered.id };
    const command = answered.data.command;
    // The Factory had given up: the Job fails, and its draft PR, branches and Working copy stay for 7 days (ADR 0010).
    if (command === "cancel" && GIVE_UP_CAUSES.has(String(request?.data.cause))) {
      return instant(() => this.record({ ...envelope, type: "job-failed", data: { reason: String(request!.data.text ?? request!.data.cause) } }));
    }
    if (command === "cancel") {
      return instant(async () => {
        await this.record({ ...envelope, type: "job-cancelled", data: { reason: `cancelled by ${answered.actor}` } });
        await this.cleanUp(job);
      });
    }
    const bounce = (from: string, to: string, extra: Record<string, unknown> = {}) =>
      instant(() => this.record({ ...envelope, type: "bounced", data: { from, to, bounce: progress.bounces + 1, answer: answered.id, ...extra } }));
    const current = resolution.stages[progress.next];
    if (command === "reject") {
      const to = rejectTarget(resolution.stages);
      if (!to) return null;
      return bounce(job.stage ?? to, to, { finding: { severity: "error", message: String(answered.data.text ?? ""), root_cause: "human-reject" } });
    }
    // `/approve` on a failed Stage that would have Bounced: one more Bounce, past the cap.
    if (command === "approve" && current?.on_fail && BOUNCE_ASKS.has(String(request?.data.cause))) return bounce(current.id, current.on_fail);
    return null;
  }

  private async runStage(ctx: StepContext, stage: ResolvedStage): Promise<void> {
    const stage_run_id = ulid();
    // Resuming with an answer is the same Stage carrying on: it is not a retry (ADR 0010).
    const answer = this.resumable(ctx, stage);
    const retry = answer || stage.kind !== "agent" ? null : retryRun(ctx.events, stage.id);
    const resume = answer
      ? { session_id: answer.session_id, input: renderHumanInput(answer.answer) }
      : retry?.kind === "resume"
        ? { session_id: retry.session_id, input: retry.input }
        : null;
    const marks = { ...(answer && { answer: answer.answered }), ...(retry && { retry_of: retry.retry_of }) };
    const started = await this.record({
      job_id: ctx.job.job_id,
      attempt: ctx.job.attempt,
      stage_run_id,
      actor: "orchestrator",
      caused_by: ctx.cause,
      ...(resume
        ? { type: "stage-resumed", data: { stage: stage.id, session_id: resume.session_id, ...marks, config_hash: this.deps.config.hash } }
        : { type: "stage-started", data: { stage: stage.id, ...marks, config_hash: this.deps.config.hash } }),
    });
    const run = { job_id: ctx.job.job_id, attempt: ctx.job.attempt, stage_run_id, actor: `stage:${stage.id}` as const, caused_by: started.id };
    const outcome = stage.kind === "check" ? await this.runCheck(ctx, stage, run) : await this.runAgent(ctx, stage, stage_run_id, run, resume);
    if (outcome.kind === "fault") await this.fault(stage, outcome, run);
    else if (outcome.kind === "interrupted") await this.interrupted(ctx, stage, outcome, run);
    else if (outcome.kind !== "stopped" && outcome.kind !== "abandoned") await this.conclude(ctx, stage, outcome, run);
  }

  /**
   * The session to resume with a human's answer: the one that asked, if this is its Stage and
   * it's under seven days old. Otherwise the Stage runs fresh with the Q&A in its brief.
   */
  private resumable(ctx: StepContext, stage: ResolvedStage): Resumable | null {
    const pending = ctx.progress.pendingAnswer;
    if (stage.kind !== "agent" || !pending?.session_id || pending.answer.stage !== stage.id) return null;
    if (this.now().getTime() - Date.parse(pending.sessionStartedAt) > RESUME_MAX_AGE_MS) return null;
    return { ...pending, session_id: pending.session_id };
  }

  private async runAgent(ctx: StepContext, stage: ResolvedStage, stage_run_id: string, run: RunEnvelope, resume: SessionResume | null): Promise<StageOutcome> {
    const { job, wc, progress } = ctx;
    const brief: StageBrief = {
      stage: stage.id,
      instructions: stage.instructions!,
      tools: stage.tools!,
      repo: job.repo,
      issue: { number: job.issue, title: ctx.approval.title, body: ctx.approval.body },
      branch: wc.branch,
      workingCopy: wc.path,
      attempt: job.attempt,
      bounce: progress.bounces,
      earlier: progress.earlier,
      conventions: await this.deps.clones.conventions(wc),
      humanAnswers: progress.answers,
    };
    const request = {
      job_id: job.job_id,
      stage_run_id,
      brief,
      renderedBrief: renderBrief(brief),
      model: stage.model!,
      workingCopy: { dir: wc.path, env: wc.env },
      network: stage.tools === "write-branch" ? (stage.network ?? []) : [],
      budget: ctx.resolution.policies.budgets.stage_run,
      resultSchema: STAGE_RESULT_SCHEMA,
    };
    // Guard denials count across every session of this Stage run (ADR 0007).
    const tally: DenialTally = { denials: 0 };
    let watched = await this.sessions.run(run, resume ? { ...request, resume } : request, tally);
    let resumeFailed: string | undefined;
    if (watched.outcome.kind === "resume-failed" && !watched.cutoff) {
      // The session can't be resumed: start a fresh one, which has the Q&A in its brief.
      resumeFailed = watched.outcome.message;
      watched = await this.sessions.run(run, request, tally);
    }
    const { outcome, cutoff, rateLimited } = watched;
    const session_id = "session_id" in outcome ? outcome.session_id : undefined;
    const facts = "facts" in outcome ? outcome.facts : {};
    if (cutoff === "stopping") return { kind: "abandoned" };
    if (cutoff === "guard-denials") {
      return { kind: "interrupted", reason: "guard-denials", message: `${MAX_GUARD_DENIALS} Guard denials in one Stage run.`, ...(session_id && { session_id }) };
    }
    if (cutoff === "idle" || cutoff === "wall-clock") {
      const limits = this.sessions.limits(request.budget);
      const message = cutoff === "idle" ? `no message from the session for ${duration(limits.idleMs)}` : `the session ran past its ${duration(limits.wallClockMs)} wall-clock Budget`;
      return { kind: "error", reason: "timeout", message, facts, ...(session_id && { session_id }) };
    }
    if (outcome.kind === "fault") return outcome;
    if (rateLimited && outcome.kind !== "output") {
      return { kind: "interrupted", reason: "plan-limit", message: "The plan's rate limit was reached.", ...(session_id && { session_id }) };
    }
    if (outcome.kind === "resume-failed") return { kind: "error", reason: "sdk-error", message: `a fresh session reported a failed resume: ${outcome.message}`, facts: {} };
    if (outcome.kind === "error") return { kind: "error", reason: outcome.reason, message: outcome.message, facts: outcome.facts, ...(outcome.where && { where: outcome.where }), ...(session_id && { session_id }) };
    const parsed = parseStageResult(outcome.output);
    if (!parsed.ok) return { kind: "error", reason: "invalid-result", message: parsed.errors.join("; "), facts: outcome.facts, ...(outcome.session_id && { session_id: outcome.session_id }) };

    const pushed = await this.pushAgentWork(ctx, stage, run);
    if (!pushed) return { kind: "stopped" };
    return {
      kind: "result",
      result: parsed.result,
      facts: { ...outcome.facts, ...pushed },
      ...(resumeFailed && { extra: { resume_failed: resumeFailed } }),
      ...(outcome.session_id && { session_id: outcome.session_id }),
    };
  }

  /** A run cut off for something outside the Stage: not a Run error, so not counted. */
  private async interrupted(ctx: StepContext, stage: ResolvedStage, outcome: Extract<StageOutcome, { kind: "interrupted" }>, run: RunEnvelope): Promise<void> {
    const ended = await this.record({
      ...run,
      actor: "orchestrator",
      type: "stage-interrupted",
      data: { stage: stage.id, reason: outcome.reason, ...(outcome.session_id && { session_id: outcome.session_id }) },
    });
    if (outcome.reason === "guard-denials") {
      await this.askHuman(ctx, { kind: "approval", cause: "guard-denials", text: `${stage.id} was stopped after ${MAX_GUARD_DENIALS} Guard denials in one Stage run; see the guard-blocked events.` }, ended.id);
    }
  }

  /**
   * Fetches what the agent committed into quarantine, runs the Pre-push checks and, if
   * they pass, pushes from the Trusted clone. Returns the measured head and changed
   * files, or null when a check failed (recorded, and the Job sent to a human).
   */
  private async pushAgentWork(ctx: StepContext, stage: ResolvedStage, run: RunEnvelope): Promise<Pick<MeasuredFacts, "head" | "files_changed"> | null> {
    const { wc, progress } = ctx;
    const before = progress.pushedHead ?? wc.base;
    const incoming = await this.deps.clones.receive(wc);
    const failures = await this.deps.prePush.run(wc, incoming, { before, profile: stage.tools! });
    if (failures.length) {
      const failed = await this.record({ ...run, type: "prepush-failed", data: { check: failures[0]!.check, failures } });
      await this.askHuman(ctx, { kind: "approval", cause: "prepush-failed", text: failures.map((f) => f.message).join("\n") }, failed.id);
      return null;
    }
    const head = incoming.head!;
    if (head === before) return { head, files_changed: [] };
    const files_changed = await this.deps.clones.filesChanged(incoming, before, head);
    await this.deps.clones.push(wc, incoming, { remoteHead: progress.pushedHead });
    const pushed = await this.record({ ...run, actor: "orchestrator", type: "branch-pushed", data: { branch: wc.branch, before, head } });
    // GitHub being down never holds up a Stage run: the Merge gate opens the PR if this couldn't.
    await this.ensurePr(ctx, pushed.id).catch((err: unknown) => {
      if (!gitHubFailed(err)) throw err;
    });
    return { head, files_changed };
  }

  /**
   * The Attempt's PR, opened as a draft the first time its branch is pushed. One already open
   * from the branch (opened by a process that died before recording it) is taken up, not doubled.
   */
  private async ensurePr(ctx: StepContext, caused_by: string): Promise<{ number: number; url: string }> {
    const known = this.deps.log.eventsFor(ctx.job.job_id).findLast((e) => e.type === "pr-opened" && e.attempt === ctx.job.attempt);
    if (known) return { number: Number(known.data.number), url: String(known.data.url) };
    const { job, wc, approval } = ctx;
    const { defaultBranch } = await this.deps.clones.trustedClone(job.repo);
    const pr =
      (await this.deps.pulls.find(job.repo, wc.branch)) ??
      (await this.deps.pulls.open(job.repo, {
        branch: wc.branch,
        base: defaultBranch,
        title: cleanAgentText(approval.title, MAX_PR_TITLE),
        draft: true,
        body: [FACTORY_MARKER, `Closes #${job.issue}.`, "", `Opened by the Factory for Job \`${job.job_id}\`; its status is kept on the issue.`, ""].join("\n"),
      }));
    await this.record({ ...jobEvent(job, caused_by), type: "pr-opened", data: { number: pr.number, url: pr.url } });
    return pr;
  }

  /**
   * Runs a Check Stage under the Sandbox in a fresh Check Stage copy of exactly the pushed head,
   * so its result is about that commit; a pass records its output as Evidence for that head.
   */
  private async runCheck(ctx: StepContext, stage: ResolvedStage, run: RunEnvelope): Promise<StageOutcome> {
    const { wc } = ctx;
    const head = ctx.progress.pushedHead ?? wc.base;
    const startedAt = Date.now();
    // Only this repo's check secrets, read by the Orchestrator itself; nothing else of its environment.
    const secrets: Record<string, string> = {};
    for (const name of stage.secrets!) {
      const value = await this.deps.secrets.get(name);
      if (value === null) return { kind: "fault", reason: "check-secret-missing", message: `Check secret ${name} isn't in the keychain (set it with \`factory secret set ${name}\`).` };
      secrets[name] = value;
    }
    const dir = await this.deps.clones.checkStageCopy(wc, head, run.stage_run_id!);
    let checked: CheckRun;
    try {
      checked = await this.deps.checks.run({
        commands: stage.commands!,
        cwd: dir,
        env: { ...secrets, ...wc.env },
        writable: [wc.env.HOME, wc.env.XDG_CACHE_HOME, wc.env.TMPDIR],
        network: stage.network!,
      });
    } catch (err) {
      // Never run unsandboxed: the check fails and the Factory pauses (ADR 0007, ADR 0010).
      if (err instanceof SandboxUnavailable) return { kind: "fault", reason: "sandbox-unavailable", message: err.message };
      throw err;
    } finally {
      this.deps.clones.removeCheckStageCopy(dir);
    }
    const blocked = checked.violations.length ? `\nThe Sandbox blocked:\n${checked.violations.map((v) => `  ${v}\n`).join("")}` : "";
    const output = this.deps.artifacts.put(checked.output + blocked);
    const facts = { cost_usd: 0, duration_ms: Date.now() - startedAt, head };
    const extra = { output, violations: checked.violations.slice(0, MAX_VIOLATIONS_IN_EVENT) };
    if (checked.passed) {
      await this.record({ ...run, actor: "orchestrator", type: "evidence-recorded", data: { stage: stage.id, head, ...output } });
      const summary = `All ${stage.commands!.length} command(s) passed.`;
      return { kind: "result", result: { verdict: "pass", summary, findings: [], artifacts: [] }, facts, extra };
    }
    const failed = checked.failed!;
    const message = `\`${failed.command}\` ${failed.timed_out ? "timed out" : `exited ${failed.exit_code}`}.`;
    return {
      kind: "result",
      result: {
        verdict: "fail",
        summary: message,
        // The same command failing again is the same root cause: output carries timings, so it can't tell.
        findings: [{ severity: "error", message, root_cause: `check:${stage.id}:${failed.command}` }],
        artifacts: [],
      },
      facts,
      extra,
    };
  }

  /** A Factory fault: pause the whole Factory, then end the Stage run, so the Job parks until it resumes. */
  private async fault(stage: ResolvedStage, fault: Extract<StageOutcome, { kind: "fault" }>, run: RunEnvelope): Promise<void> {
    const paused = await this.record({ type: "factory-paused", actor: "orchestrator", caused_by: run.caused_by, data: { reason: fault.reason, message: fault.message } });
    await this.record({ ...run, actor: "orchestrator", caused_by: paused.id, type: "stage-interrupted", data: { stage: stage.id, reason: fault.reason } });
  }

  /**
   * Records how the Stage run ended and where the Pipeline goes next, then the checkpoint
   * after a Stage result: an agent run over its hard Budget pauses the Job (budget).
   */
  private async conclude(ctx: StepContext, stage: ResolvedStage, outcome: Extract<StageOutcome, { kind: "result" | "error" }>, run: RunEnvelope): Promise<void> {
    const hit =
      stage.kind === "agent"
        ? budgetAfterStageRun({ budget: ctx.resolution.policies.budgets.stage_run, facts: outcome.facts, ...(outcome.kind === "error" && { errorReason: outcome.reason }) })
        : null;
    const last = await this.route(ctx, stage, outcome, run, hit !== null);
    // A Job the route already sent to a human stays there; the request says enough.
    if (hit && this.deps.log.job(ctx.job.job_id)?.status === "queued") await this.budgetExceeded(ctx.job, hit, "after-stage-result", last.id);
  }

  /** Records the Stage run's ending and the Pipeline's next move. Returns the last event recorded. */
  private async route(ctx: StepContext, stage: ResolvedStage, outcome: Extract<StageOutcome, { kind: "result" | "error" }>, run: RunEnvelope, overBudget: boolean): Promise<FactoryEvent> {
    const { job } = ctx;
    const ended = await this.recordEnding(ctx, stage, outcome, run);
    // The issue changed while this ran: the result is held, and the Pipeline moves only after re-approval.
    if (this.heldForReapproval(job)) return ended;
    if (outcome.kind === "error") {
      const errored = ended;
      // A hit Budget pauses the Job rather than retrying or asking (ADR 0010).
      if (overBudget) return errored;
      // Otherwise the Job is queued again and the Stage retries, unless a human must decide.
      const ask = afterRunError([...ctx.events, errored], stage.id);
      return ask ? this.askHuman(ctx, { kind: "approval", ...ask }, errored.id) : errored;
    }

    const { result } = outcome;
    if (result.verdict === "pass") return ended;
    if (result.verdict === "needs-human") {
      return this.askHuman(ctx, { kind: "question", text: result.question!.text, options: result.question!.options }, ended.id);
    }

    return this.bounceOrAsk(ctx, { from: stage.id, to: stage.on_fail, summary: result.summary, findings: result.findings }, ended.id);
  }

  /**
   * A failure Bounces to `to` with its findings, unless a human must decide: no Stage to Bounce
   * to, the Bounce cap reached, or a root cause that has Bounced before. `own` marks a failure
   * no Stage run recorded (the Merge gate's), whose findings the Bounce itself carries.
   */
  private bounceOrAsk(ctx: StepContext, failure: { from: string; to: string | undefined; summary: string; findings: Finding[]; own?: boolean }, caused_by: string): Promise<FactoryEvent> {
    const { job, progress, resolution } = ctx;
    const { from, to, summary, findings } = failure;
    const repeated = findings.filter((f) => progress.bouncedRootCauses.has(f.root_cause)).map((f) => f.root_cause);
    if (!to) return this.askHuman(ctx, { kind: "approval", cause: "no-bounce-target", text: `${from} failed and has no on_fail Stage. ${summary}` }, caused_by);
    if (progress.bounces >= resolution.policies.bounce_cap) {
      return this.askHuman(ctx, { kind: "approval", cause: "bounce-cap", text: `${from} failed after ${progress.bounces} Bounces (cap ${resolution.policies.bounce_cap}). ${summary}` }, caused_by);
    }
    if (repeated.length) {
      return this.askHuman(ctx, { kind: "approval", cause: "repeated-root-cause", text: `${from} failed again for the same root cause: ${[...new Set(repeated)].join(", ")}.` }, caused_by);
    }
    return this.record({ ...jobEvent(job, caused_by), type: "bounced", data: { from, to, bounce: progress.bounces + 1, ...(failure.own && { summary, findings }) } });
  }

  private inMergeLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const next = (this.mergeLocks.get(repo) ?? Promise.resolve()).then(work, work);
    this.mergeLocks.set(repo, next.catch(() => undefined));
    return next;
  }

  /**
   * The Merge gate checkpoint (ADR 0004), once every Stage has passed: the fixed core, Risk rules,
   * the Autonomy level and any `/approve` decide. To merge, the Job branch is first rebased onto
   * the current default branch; if that moved it, the Check Stages run again on the new head and
   * the gate decides afresh. The merge itself only goes through if the PR's head is still the
   * head the gate checked. GitHub being down only makes the merge wait (ADR 0010).
   */
  private async mergeGate(ctx: StepContext): Promise<boolean> {
    const { job, wc, resolution, approval } = ctx;
    const head = ctx.progress.pushedHead ?? wc.base;
    let pr: { number: number; url: string };
    let state: PullRequest;
    try {
      pr = await this.ensurePr(ctx, ctx.cause ?? "");
      state = await this.deps.pulls.get(job.repo, pr.number);
    } catch (err) {
      if (gitHubFailed(err)) return false;
      throw err;
    }
    if (state.state === "merged") return this.mergedUnrecorded(ctx, pr, state);

    // A head the Orchestrator didn't push has no Evidence; there's nothing more to measure about it.
    const ours = state.head === head;
    const change = ours ? await this.deps.clones.changes(wc, head) : { files: [], packageJson: [] };
    const commands = resolution.stages.flatMap((s) => (s.kind === "check" ? (s.commands ?? []) : []));
    const gate = evaluateMergeGate({
      head: state.head,
      stages: stagesAtGate(ctx.events, resolution.stages),
      evidence: ctx.events.filter((e) => e.type === "evidence-recorded").map((e) => ({ head: String(e.data.head), ...(typeof e.data.stage === "string" && { stage: e.data.stage }) })),
      pr: state.state === "open" ? { checks: state.checks, conflicts: state.conflicts } : null,
      selfEdits: selfEditedChecks({ files: change.files, commands, packageJson: change.packageJson }),
    });
    const risks = matchRiskRules(resolution.riskRules, { labels: approval.labels, files: change.files, sizeCap: resolution.policies.size_cap });
    const decision = decideMerge({ autonomy: resolution.policies.autonomy, gate, risks, approved: approvedAtMergeGate(ctx.events) });
    if (decision.action === "merge" && this.refusedThisPass.has(job.job_id)) return false;
    // Waiting on the PR's checks: recorded once, not at every look.
    if (decision.action === "wait" && !ctx.reply && sameWait(ctx.events, state.head, decision)) return false;

    // To merge, the branch must contain the current default branch: rebase first, and say so.
    const rebase = decision.action === "merge" ? await this.deps.clones.rebaseOntoDefault(wc, state.head) : null;
    let last = ctx.cause;
    for (const e of mergeGateEvents(state.head, gate, decision)) {
      const data = e.type === "checkpoint-evaluated" && rebase ? { ...e.data, ...rebaseCheckpoint(rebase) } : e.data;
      last = (await this.record({ ...jobEvent(job, last), ...e, data })).id;
    }
    if (decision.action === "wait") return true;
    if (decision.action === "ask") {
      // Nothing but your say-so stands in the way: the PR is ready for you to review, or merge yourself.
      if (gate.passed && state.draft) await this.deps.pulls.markReady(job.repo, pr.number).catch(() => null);
      const would = decision.wouldHaveMerged;
      const text = would ? `${decision.why}\n\nIn auto, the Factory ${would.would ? "would have merged" : "wouldn't have merged"}: ${would.why}.` : decision.why;
      await this.askHuman(ctx, { kind: "approval", cause: decision.cause, text }, last);
      return true;
    }
    return this.merge(ctx, pr, state, rebase!, last!);
  }

  /**
   * GitHub says the PR is merged but the Event log doesn't: the Factory merged it and died before
   * recording so, if its gate last decided to merge exactly this head. Anyone else's merge the
   * Source reports, and the Job ends then.
   */
  private async mergedUnrecorded(ctx: StepContext, pr: { number: number }, state: PullRequest): Promise<boolean> {
    const decided = ctx.events.findLast((e) => e.type === "checkpoint-evaluated" && e.data.checkpoint === "merge-gate");
    const gateAt = ctx.events.findLast((e) => e.type === "merge-gate-evaluated");
    if (decided?.data.outcome !== "merge" || gateAt?.data.head !== state.head || !state.mergeCommit) return false;
    await this.record({ ...jobEvent(ctx.job, decided.id), type: "pr-merged", data: { number: pr.number, sha: state.mergeCommit } });
    await this.cleanUp(ctx.job);
    return true;
  }

  /** After the rebase: a moved branch is recorded (its Check Stages run next), a conflict Bounces, and an up-to-date one merges exactly the head the gate passed. */
  private async merge(ctx: StepContext, pr: { number: number }, state: PullRequest, rebase: Rebase, caused_by: string): Promise<boolean> {
    const { job, resolution, approval } = ctx;
    const head = state.head;
    if (rebase.kind === "rebased") {
      await this.record({ ...jobEvent(job, caused_by), type: "rebased", data: { base: rebase.base, before: head, head: rebase.head } });
      return true;
    }
    if (rebase.kind === "conflict") {
      const at = rebase.base.slice(0, 12);
      const findings = rebase.files.map((file): Finding => ({
        severity: "error",
        file,
        message: `${file} conflicts with the default branch at ${at}. Merge ${rebase.base} into the branch and resolve the conflict.`,
        root_cause: `rebase-conflict:${file}`,
      }));
      // A rebase that stopped without naming a file still has one root cause, so it can't Bounce unnoticed.
      if (!findings.length) findings.push({ severity: "error", message: `Rebasing onto the default branch at ${at} failed. Merge ${rebase.base} into the branch.`, root_cause: "rebase-failed" });
      const summary = rebase.files.length ? `Rebasing onto the default branch at ${at} conflicts in ${rebase.files.join(", ")}.` : `Rebasing onto the default branch at ${at} failed.`;
      await this.bounceOrAsk(ctx, { from: "merge-gate", to: rejectTarget(resolution.stages) ?? undefined, summary, findings, own: true }, caused_by);
      return true;
    }
    let outcome;
    try {
      if (state.draft) await this.deps.pulls.markReady(job.repo, pr.number);
      outcome = await this.deps.pulls.merge(job.repo, pr.number, { sha: head, title: `${cleanAgentText(approval.title, MAX_PR_TITLE - 10)} (#${pr.number})`, method: resolution.mergeMethod });
    } catch (err) {
      if (gitHubFailed(err)) return false;
      throw err;
    }
    if (!outcome.merged) {
      const refused = await this.record({ ...jobEvent(job, caused_by), type: "checkpoint-evaluated", data: { checkpoint: "merge-gate", outcome: "merge-refused", why: `GitHub refused the merge: ${outcome.message}` } });
      // Branch protection or a required review: trying again won't help, so a human decides.
      if (outcome.why === "not-mergeable") {
        await this.askHuman(ctx, { kind: "approval", cause: "merge-gate", text: `GitHub won't merge #${pr.number}: ${outcome.message}` }, refused.id);
        return true;
      }
      // `--match-head-commit` refused: the gate runs again on what's there now.
      this.refusedThisPass.add(job.job_id);
      return true;
    }
    await this.record({ ...jobEvent(job, caused_by), type: "pr-merged", data: { number: pr.number, sha: outcome.sha } });
    await this.cleanUp(job);
    return true;
  }

  /**
   * A merged or cancelled Job's branches and Working copies go (ADR 0010). A branch that can't be
   * deleted now, GitHub being down say, is left to housekeeping.
   */
  private async cleanUp(job: JobState): Promise<void> {
    const branches = this.deps.log.eventsFor(job.job_id).filter((e) => e.type === "attempt-started").map((e) => String(e.data.branch));
    await this.deps.clones.deleteBranches(job.repo, branches).catch(() => null);
    await this.deps.clones.removeJob(job.job_id);
  }

  /** Records how a Stage run ended: its Run error, or its Verdict with what the Orchestrator measured. */
  private recordEnding(ctx: StepContext, stage: ResolvedStage, outcome: Extract<StageOutcome, { kind: "result" | "error" }>, run: RunEnvelope): Promise<FactoryEvent> {
    if (outcome.kind === "error") {
      return this.record({
        ...run,
        type: "stage-errored",
        data: {
          stage: stage.id,
          reason: outcome.reason,
          message: outcome.message,
          ...outcome.facts,
          ...(outcome.where && { where: outcome.where }),
          ...(outcome.session_id && { session_id: outcome.session_id }),
        },
      });
    }
    const { result } = outcome;
    const data = { stage: stage.id, result, ...outcome.facts, ...outcome.extra };
    if (result.verdict === "pass") return this.record({ ...run, type: "stage-passed", data });
    if (result.verdict === "needs-human") {
      return this.record({
        ...run,
        type: "stage-needs-human",
        data: { ...data, question: result.question!.text, options: result.question!.options, ...(outcome.session_id && { session_id: outcome.session_id }) },
      });
    }
    return this.record({ ...run, type: "stage-failed", data: { ...data, summary: result.summary } });
  }

  private heldForReapproval(job: JobState): boolean {
    const now = this.deps.log.job(job.job_id);
    return now?.status === "waiting" && now.reason === "reapproval";
  }

  /** Sends the Job to waiting with a Human request, which the Mirrors post, and tells this machine about it. */
  private async askHuman(ctx: StepContext, data: { kind: "question" | "approval"; cause?: string; text: string; options?: string[] }, caused_by: string | null) {
    const { job } = ctx;
    // A Job held for re-approval has its request already: anything else waits until that's answered.
    if (data.cause !== "reapproval" && this.heldForReapproval(job)) {
      const cause = caused_by ? this.deps.log.store.get(caused_by) : undefined;
      if (cause) return cause;
    }
    const stage = this.deps.log.job(job.job_id)?.stage;
    const rejectTo = rejectTarget(ctx.resolution.stages);
    const requested = await this.record({
      ...jobEvent(job, caused_by),
      type: "human-requested",
      data: { ...data, ...(stage && { stage }), ...(data.kind === "approval" && rejectTo && { reject_to: rejectTo }) },
    });
    try {
      await this.deps.notifier?.notify({ title: `Factory: ${job.repo}#${job.issue} needs you`, body: data.text });
    } catch {
      // A notification is a courtesy; the request stands without it.
    }
    return requested;
  }

  /** Records one event and hands it to every Mirror. */
  private async record(event: NewEvent): Promise<FactoryEvent> {
    let recorded: FactoryEvent;
    try {
      recorded = this.deps.log.record(event);
    } catch (err) {
      throw new JobStoreUnwritable(err);
    }
    await this.mirror(recorded);
    return recorded;
  }

  /** Hands a recorded event to every Mirror. A Mirror failing never blocks a Job (ADR 0002). */
  private async mirror(recorded: FactoryEvent): Promise<void> {
    const job = recorded.job_id ? this.deps.log.job(recorded.job_id) : undefined;
    if (job) {
      for (const mirror of this.deps.mirrors) {
        try {
          await mirror.write({ event: recorded, job });
        } catch {
          // A Mirror saves to its outbox and delivers in the background; even that failing never blocks a Job.
        }
      }
    }
  }
}

/** The `factory-paused` reason while the Source refuses the Factory's credentials. */
const SOURCE_CREDENTIALS = "source-credentials";

/** The Job store cursor the Source poll carries on from. */
const SOURCE_CURSOR = "source";

/** When a plan limit gives no reset time, look again after an hour. */
const PLAN_LIMIT_FALLBACK_MS = 60 * 60_000;

const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms}ms`);

/** The envelope of an event the Orchestrator records about a Job's current Attempt. */
const jobEvent = (job: JobState, caused_by: string | null) => ({ job_id: job.job_id, attempt: job.attempt, actor: "orchestrator" as const, caused_by });

/** A pending answer whose asking session can be resumed. */
type Resumable = PendingAnswer & { session_id: string };

/** Events that record what happened around a Job without moving it: never the cause of its next step. */
const NOT_CAUSES = new Set(["reply-ignored", "human-reminded", "transition-rejected"]);

/** Events by which the Orchestrator has acted on a Reply command, or moved past it. */
const ACTED_ON = new Set(["stage-started", "stage-resumed", "stage-skipped", "bounced", "job-cancelled", "human-requested", "attempt-started", "checkpoint-evaluated", "budget-exceeded", "pr-merged", "rebased"]);

/** Human requests whose `/approve` means one more Bounce. */
const BOUNCE_ASKS = new Set(["bounce-cap", "repeated-root-cause"]);

const DAY_MS = 24 * 60 * 60 * 1000;
/** A session older than this runs fresh, with the Q&A in its brief, instead of resuming. */
const RESUME_MAX_AGE_MS = 7 * DAY_MS;
const REMIND_AFTER_MS = 3 * DAY_MS;

/** The latest Reply command recorded, if nothing has acted on it yet. */
function pendingReply(events: FactoryEvent[]): StepContext["reply"] {
  const at = events.findLastIndex((e) => e.type === "human-answered");
  if (at === -1 || events.slice(at + 1).some((e) => ACTED_ON.has(e.type))) return null;
  const answered = events[at]!;
  return { answered, request: events.find((e) => e.id === answered.data.request) };
}

/** Where `/reject` Bounces to: the Pipeline's build Stage (its first that writes the branch), else its first Stage. */
function rejectTarget(stages: ResolvedStage[]): string | null {
  return (stages.find((s) => s.kind === "agent" && s.tools === "write-branch") ?? stages[0])?.id ?? null;
}

/** GitHub couldn't be reached, or refused: either way it's GitHub's answer, never a reason to stop the Factory. */
const gitHubFailed = (err: unknown) => err instanceof GitHubUnavailable || err instanceof GitHubError;

/** GitHub caps PR titles at 256 characters. */
const MAX_PR_TITLE = 256;

/** Event data stays small; the output artifact holds every violation. */
const MAX_VIOLATIONS_IN_EVENT = 20;

const instant = (run: () => Promise<unknown>): Plan => ({ kind: "instant", run: async () => (await run(), true) });

/** What a gate that decided to merge records instead, when the branch first had to be rebased. */
function rebaseCheckpoint(rebase: Rebase): { outcome: string; why: string } | Record<string, never> {
  const at = rebase.base.slice(0, 12);
  if (rebase.kind === "rebased") return { outcome: "rebase", why: `the default branch moved to ${at}: rebasing, then the Check Stages run again` };
  if (rebase.kind === "conflict") return { outcome: "rebase-conflict", why: `rebasing onto the default branch at ${at} conflicts` };
  return {};
}

/** The gate last decided to wait, at the same head, for the same reason. */
function sameWait(events: FactoryEvent[], head: string, decision: MergeDecision): boolean {
  const gate = events.findLast((e) => e.type === "merge-gate-evaluated");
  const checkpoint = events.findLast((e) => e.type === "checkpoint-evaluated" && e.data.checkpoint === "merge-gate");
  return gate?.data.head === head && checkpoint?.data.outcome === "wait" && checkpoint.data.why === decision.why && checkpoint.seq > gate.seq;
}

/** One branch per Attempt of an issue: `factory/<issue>`, then `factory/<issue>-a2`, … (ADR 0002). */
const attemptBranch = (issue: number, attempt: number) => (attempt > 1 ? `factory/${issue}-a${attempt}` : `factory/${issue}`);


/** A `job-retried` no Attempt has started for yet. */
function pendingRetry(events: FactoryEvent[]): FactoryEvent | null {
  const retried = events.findLastIndex((e) => e.type === "job-retried");
  if (retried === -1 || events.slice(retried + 1).some((e) => e.type === "attempt-started")) return null;
  return events[retried]!;
}

/**
 * The issue as last approved: at Job approval, re-approved by re-labelling for a new Attempt,
 * or edited since by someone on `humans` (or by anyone, once a human `/approve`d the edit).
 */
function approvalOf(events: FactoryEvent[]): Approval {
  const byId = new Map(events.map((e) => [e.id, e]));
  let text: Record<string, unknown> = {};
  let labels: unknown = [];
  let pendingEdit: Record<string, unknown> | null = null;
  for (const e of events) {
    if (e.type === "job-approved" || (e.type === "job-retried" && typeof e.data.body === "string")) {
      text = e.data;
      labels = e.data.labels ?? labels;
      pendingEdit = null;
    } else if (e.type === "issue-edited") {
      if (e.data.allowed === true) text = e.data;
      else pendingEdit = e.data;
    } else if (e.type === "human-answered" && e.data.command === "approve" && pendingEdit && byId.get(String(e.data.request))?.data.cause === "reapproval") {
      text = pendingEdit;
      pendingEdit = null;
    }
  }
  return {
    title: String(text.title ?? ""),
    body: String(text.body ?? ""),
    labels: Array.isArray(labels) ? (labels as string[]) : [],
  };
}

function conditionHolds(when: StageCondition, labels: string[], filesChanged: Set<string>): boolean {
  const { labels: wanted = [], paths = [] } = when;
  if (wanted.some((l) => labels.includes(l))) return true;
  const matches = paths.length ? picomatch(paths, { dot: true }) : null;
  return matches !== null && [...filesChanged].some((f) => matches(f));
}

function describeCondition(when: StageCondition): string {
  const parts = [];
  if (when.labels) parts.push(`no label in [${when.labels.join(", ")}]`);
  if (when.paths) parts.push(`no changed file matches [${when.paths.join(", ")}]`);
  return `when: ${parts.join(" and ")}`;
}
