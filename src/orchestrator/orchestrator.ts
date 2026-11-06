import picomatch from "picomatch";
import { ulid } from "ulid";
import type { AgentAdapter, MeasuredFacts, RunErrorReason } from "../agents/adapter.js";
import type { ConfigHolder } from "../config/holder.js";
import { resolve, type Resolution, type ResolvedStage } from "../config/resolve.js";
import type { StageCondition } from "../config/types.js";
import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { EventLog } from "../jobs/event-log.js";
import type { JobState } from "../jobs/projection.js";
import type { Mirror } from "../mirror/mirror.js";
import { budgetAfterStageRun, budgetBeforeStageRun, spentToday, type BudgetHit } from "../policies/budgets.js";
import type { Checkpoint } from "../policies/checkpoint.js";
import type { PrePushChecks } from "../repos/prepush.js";
import type { Clones, WorkingCopy } from "../repos/clones.js";
import type { Source, SourceItem } from "../source/source.js";
import { renderBrief, renderHumanInput, type StageBrief } from "../stages/brief.js";
import { parseReplyCommand } from "../humans/commands.js";
import type { Notifier } from "../humans/notify.js";
import { recordMalformedReply, recordReply } from "../humans/replies.js";
import type { SecretStore } from "../secrets/keychain.js";
import { SandboxUnavailable, type CheckRun, type CheckRunner } from "../stages/check-runner.js";
import { parseStageResult, STAGE_RESULT_SCHEMA, type StageResult } from "../stages/result.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { attemptProgress, type AttemptProgress, type PendingAnswer } from "./progress.js";

export interface OrchestratorDeps {
  log: EventLog;
  config: ConfigHolder;
  source: Source;
  agent: AgentAdapter;
  checks: CheckRunner;
  mirrors: Mirror[];
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
}

/** The approved issue, as recorded on `job-approved`. */
interface Approval {
  title: string;
  body: string;
  labels: string[];
}

type StageOutcome =
  | { kind: "result"; result: StageResult; facts: Partial<MeasuredFacts>; extra?: Record<string, unknown>; session_id?: string }
  | { kind: "error"; reason: RunErrorReason | "invalid-result"; message: string; facts: Partial<MeasuredFacts> }
  /** A Pre-push check failed: already recorded, and the Job is waiting. */
  | { kind: "stopped" }
  /** A Factory fault (ADR 0010): the run ends without a Verdict and the whole Factory pauses. */
  | { kind: "fault"; reason: "sandbox-unavailable" | "check-secret-missing"; message: string };

/** Everything one step of one Job is decided from. */
interface StepContext {
  job: JobState;
  approval: Approval;
  resolution: Resolution;
  progress: AttemptProgress;
  wc: WorkingCopy;
  /** The Job's latest event: whatever this step does, it happens because of it. */
  cause: string | null;
  /** A Reply command recorded since the Job's last step, which this step acts on. */
  reply: { answered: FactoryEvent; request: FactoryEvent | undefined } | null;
}

/** What a queued Job does next: something instant, or a Stage run that needs a free slot. */
type Plan = { kind: "instant"; run: () => Promise<void> } | { kind: "stage-run"; repoLimit: number; run: () => Promise<void> };

/**
 * Owns Job state, Stage order and every git and GitHub write (ADR 0001). Each step is
 * decided from the Event log and config alone; Verdicts only route (ADR 0003).
 */
export class Orchestrator {
  private cursor: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Polls the Source once, then keeps Jobs moving until none can without something new
   * happening. Stage runs go in parallel up to `max_running`, Factory-wide and per repo;
   * queued Jobs start resumed first, then first come, first served by Job approval (ADR 0008).
   */
  async runUntilIdle(): Promise<void> {
    await this.poll();
    await this.remind();
    const running = new Map<string, { repo: string; done: Promise<void> }>();
    // A Stage run that throws is a fault for #27 to classify; until then, let the others
    // finish rather than abandon them mid-run, and rethrow once nothing is running.
    const faults: unknown[] = [];
    for (;;) {
      let moved = false;
      // After a fault, start nothing new; only let what's running finish.
      for (const job of faults.length ? [] : this.queue(running)) {
        const plan = await this.plan(job);
        if (!plan) continue;
        if (plan.kind === "instant") {
          await plan.run();
          moved = true;
          break; // the queue may look different now
        }
        const inRepo = [...running.values()].filter((r) => r.repo === job.repo).length;
        if (running.size >= this.deps.config.current.max_running || inRepo >= plan.repoLimit) continue;
        const done = plan
          .run()
          .catch((err: unknown) => void faults.push(err))
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

  private queue(running: Map<string, unknown>): JobState[] {
    const queued = this.deps.log.jobs().filter((j) => j.status === "queued" && !running.has(j.job_id));
    // Array.prototype.sort is stable, so approval order holds within each group.
    return queued.sort((a, b) => Number(b.resumed) - Number(a.resumed));
  }

  private async poll(): Promise<void> {
    const { items, cursor } = await this.deps.source.poll(this.cursor);
    for (const item of items) await this.admit(item);
    this.cursor = cursor;
  }

  private async admit(item: SourceItem): Promise<void> {
    if (item.kind === "comment") return this.reply(item);
    const issue = item.kind === "approved" ? item.issue.number : item.issue;
    const live = this.deps.log.jobs().find((j) => j.repo === item.repo && j.issue === issue && isLive(j));
    if (item.kind === "unapproved") {
      if (live) {
        await this.record({ type: "job-cancelled", job_id: live.job_id, actor: `human:${item.by}`, data: { reason: "ready label removed" } });
        await this.deps.clones.removeJob(live.job_id);
      }
      return;
    }
    if (live) return; // One live Job per issue.
    const job_id = ulid();
    const approval = await this.record({
      type: "job-approved",
      job_id,
      actor: `human:${item.by}`,
      data: { repo: item.repo, issue: item.issue.number, title: item.issue.title, body: item.issue.body, labels: item.labels },
    });
    const branch = attemptBranch(item.issue.number, 1);
    const wc = await this.deps.clones.startAttempt({ repo: item.repo, job_id, attempt: 1, branch });
    await this.record({ type: "attempt-started", job_id, attempt: 1, actor: "orchestrator", caused_by: approval.id, data: { branch, base: wc.base } });
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

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async plan(job: JobState): Promise<Plan | null> {
    // Edits to factory.yaml apply at the next Stage run (ADR 0005).
    if (this.deps.config.refresh().changed) {
      await this.record({ type: "config-reloaded", actor: "orchestrator", data: { config_hash: this.deps.config.hash } });
    }
    const ctx = this.context(job);
    const base = { job_id: job.job_id, attempt: job.attempt, caused_by: ctx.cause };
    const acting = ctx.reply && this.actOnReply(ctx, ctx.reply.answered, ctx.reply.request);
    if (acting) return acting;

    if (ctx.resolution.errors.length) {
      return instant(() => this.askHuman(ctx, { kind: "question", cause: "cannot-start", text: ctx.resolution.errors.join("\n") }, ctx.cause));
    }
    const stage = ctx.resolution.stages[ctx.progress.next];
    if (!stage) {
      if (ctx.progress.atMergeGate) return null;
      // Merge gate decisions come in #25; this Job has reached the checkpoint.
      return instant(() => this.record({ ...base, type: "checkpoint-evaluated", actor: "orchestrator", data: { checkpoint: "merge-gate" } }));
    }
    if (stage.when && !conditionHolds(stage.when, ctx.approval.labels, ctx.progress.filesChanged)) {
      return instant(() => this.record({ ...base, type: "stage-skipped", actor: "orchestrator", data: { stage: stage.id, why: describeCondition(stage.when!) } }));
    }
    // Checkpoint before a Stage run: the soft Budgets. A Stage run already going finishes (ADR 0004).
    const hit = this.softBudgetHit(job, ctx.resolution);
    if (hit) return instant(() => this.budgetExceeded(job, hit, "before-stage-run", ctx.cause));
    return { kind: "stage-run", repoLimit: ctx.resolution.maxRunning, run: () => this.runStage(ctx, stage) };
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
    return { job, approval, resolution, progress, wc, cause, reply: pendingReply(events) };
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
    if (command === "cancel") {
      return instant(async () => {
        await this.record({ ...envelope, type: "job-cancelled", data: { reason: `cancelled by ${answered.actor}` } });
        await this.deps.clones.removeJob(job.job_id);
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
    const resume = this.resumable(ctx, stage);
    const started = await this.record({
      job_id: ctx.job.job_id,
      attempt: ctx.job.attempt,
      stage_run_id,
      actor: "orchestrator",
      caused_by: ctx.cause,
      // Resuming with an answer is the same Stage carrying on: it is not retried (ADR 0010).
      ...(resume
        ? { type: "stage-resumed", data: { stage: stage.id, session_id: resume.session_id, answer: resume.answered, config_hash: this.deps.config.hash } }
        : { type: "stage-started", data: { stage: stage.id, config_hash: this.deps.config.hash } }),
    });
    const run = { job_id: ctx.job.job_id, attempt: ctx.job.attempt, stage_run_id, actor: `stage:${stage.id}` as const, caused_by: started.id };
    const outcome = stage.kind === "check" ? await this.runCheck(ctx, stage, run) : await this.runAgent(ctx, stage, stage_run_id, run, resume);
    if (outcome.kind === "fault") await this.fault(stage, outcome, run);
    else if (outcome.kind !== "stopped") await this.conclude(ctx, stage, outcome, run);
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

  private async runAgent(ctx: StepContext, stage: ResolvedStage, stage_run_id: string, run: RunEnvelope, resume: Resumable | null): Promise<StageOutcome> {
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
      stage_run_id,
      brief,
      renderedBrief: renderBrief(brief),
      model: stage.model!,
      workingCopy: { dir: wc.path, env: wc.env },
      budget: ctx.resolution.policies.budgets.stage_run,
      resultSchema: STAGE_RESULT_SCHEMA,
    };
    let outcome = await this.deps.agent.run(resume ? { ...request, resume: { session_id: resume.session_id, input: renderHumanInput(resume.answer) } } : request);
    let resumeFailed: string | undefined;
    if (outcome.kind === "resume-failed") {
      // The session can't be resumed: start a fresh one, which has the Q&A in its brief.
      resumeFailed = outcome.message;
      outcome = await this.deps.agent.run(request);
    }
    if (outcome.kind === "resume-failed") return { kind: "error", reason: "sdk-error", message: `a fresh session reported a failed resume: ${outcome.message}`, facts: {} };
    if (outcome.kind === "error") return outcome;
    const parsed = parseStageResult(outcome.output);
    if (!parsed.ok) return { kind: "error", reason: "invalid-result", message: parsed.errors.join("; "), facts: outcome.facts };

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
    await this.record({ ...run, actor: "orchestrator", type: "branch-pushed", data: { branch: wc.branch, before, head } });
    return { head, files_changed };
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
    const { job, progress, resolution } = ctx;
    if (outcome.kind === "error") {
      const errored = await this.record({
        ...run,
        type: "stage-errored",
        data: { stage: stage.id, reason: outcome.reason, message: outcome.message, ...outcome.facts },
      });
      // A hit Budget pauses the Job rather than asking about a Run error.
      if (overBudget) return errored;
      // Retrying Run errors comes in #27; until then a human decides.
      return this.askHuman(ctx, { kind: "approval", cause: "run-error", text: `${stage.id} ${outcome.reason}: ${outcome.message}` }, errored.id);
    }

    const { result } = outcome;
    const data = { stage: stage.id, result, ...outcome.facts, ...outcome.extra };
    if (result.verdict === "pass") return this.record({ ...run, type: "stage-passed", data });
    if (result.verdict === "needs-human") {
      const asked = await this.record({
        ...run,
        type: "stage-needs-human",
        data: { ...data, question: result.question!.text, options: result.question!.options, ...(outcome.session_id && { session_id: outcome.session_id }) },
      });
      return this.askHuman(ctx, { kind: "question", text: result.question!.text, options: result.question!.options }, asked.id);
    }

    const failed = await this.record({ ...run, type: "stage-failed", data: { ...data, summary: result.summary } });
    const repeated = result.findings.filter((f) => progress.bouncedRootCauses.has(f.root_cause)).map((f) => f.root_cause);
    if (!stage.on_fail) {
      return this.askHuman(ctx, { kind: "approval", cause: "no-bounce-target", text: `${stage.id} failed and has no on_fail Stage. ${result.summary}` }, failed.id);
    }
    if (progress.bounces >= resolution.policies.bounce_cap) {
      return this.askHuman(ctx, { kind: "approval", cause: "bounce-cap", text: `${stage.id} failed after ${progress.bounces} Bounces (cap ${resolution.policies.bounce_cap}). ${result.summary}` }, failed.id);
    }
    if (repeated.length) {
      return this.askHuman(ctx, { kind: "approval", cause: "repeated-root-cause", text: `${stage.id} failed again for the same root cause: ${[...new Set(repeated)].join(", ")}.` }, failed.id);
    }
    return this.record({ ...jobEvent(job, failed.id), type: "bounced", data: { from: stage.id, to: stage.on_fail, bounce: progress.bounces + 1 } });
  }

  /** Sends the Job to waiting with a Human request, which the Mirrors post, and tells this machine about it. */
  private async askHuman(ctx: StepContext, data: { kind: "question" | "approval"; cause?: string; text: string; options?: string[] }, caused_by: string | null) {
    const { job } = ctx;
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
    const recorded = this.deps.log.record(event);
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
          // The outbox that retries Mirror writes comes in #32.
        }
      }
    }
  }
}

type RunEnvelope = Pick<NewEvent, "job_id" | "attempt" | "stage_run_id" | "actor" | "caused_by">;

/** The envelope of an event the Orchestrator records about a Job's current Attempt. */
const jobEvent = (job: JobState, caused_by: string | null) => ({ job_id: job.job_id, attempt: job.attempt, actor: "orchestrator" as const, caused_by });

/** A pending answer whose asking session can be resumed. */
type Resumable = PendingAnswer & { session_id: string };

/** Events that record what happened around a Job without moving it: never the cause of its next step. */
const NOT_CAUSES = new Set(["reply-ignored", "human-reminded", "transition-rejected"]);

/** Events by which the Orchestrator has acted on a Reply command, or moved past it. */
const ACTED_ON = new Set(["stage-started", "stage-resumed", "stage-skipped", "bounced", "job-cancelled", "human-requested", "attempt-started", "checkpoint-evaluated", "budget-exceeded"]);

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

/** Event data stays small; the output artifact holds every violation. */
const MAX_VIOLATIONS_IN_EVENT = 20;

const instant = (run: () => Promise<unknown>): Plan => ({ kind: "instant", run: async () => void (await run()) });

/** One branch per Attempt: `factory/<issue>`, then `factory/<issue>-a2`, … (ADR 0002). */
const attemptBranch = (issue: number, attempt: number) => (attempt > 1 ? `factory/${issue}-a${attempt}` : `factory/${issue}`);

const isLive = (j: JobState) => !["merged", "failed", "cancelled"].includes(j.status);

function approvalOf(events: FactoryEvent[]): Approval {
  const data = events.find((e) => e.type === "job-approved")?.data ?? {};
  return {
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    labels: Array.isArray(data.labels) ? (data.labels as string[]) : [],
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
