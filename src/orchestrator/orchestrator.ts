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
import type { PrePushChecks } from "../repos/prepush.js";
import type { RepoWorkspace, WorkingCopy } from "../repos/workspace.js";
import type { Source, SourceItem } from "../source/source.js";
import { renderBrief, type StageBrief } from "../stages/brief.js";
import type { CheckRunner } from "../stages/check-runner.js";
import { parseStageResult, STAGE_RESULT_SCHEMA, type StageResult } from "../stages/result.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { attemptProgress, type AttemptProgress } from "./progress.js";

export interface OrchestratorDeps {
  log: EventLog;
  config: ConfigHolder;
  source: Source;
  agent: AgentAdapter;
  checks: CheckRunner;
  mirrors: Mirror[];
  artifacts: ArtifactStore;
  /** Trusted clones and Working copies (ADR 0008). */
  workspace: RepoWorkspace;
  prePush: PrePushChecks;
}

/** The approved issue, as recorded on `job-approved`. */
interface Approval {
  title: string;
  body: string;
  labels: string[];
}

type StageOutcome =
  | { kind: "result"; result: StageResult; facts: Partial<MeasuredFacts>; extra?: Record<string, unknown> }
  | { kind: "error"; reason: RunErrorReason | "invalid-result"; message: string; facts: Partial<MeasuredFacts> }
  /** A Pre-push check failed: already recorded, and the Job is waiting. */
  | { kind: "stopped" };

/** Everything one step of one Job is decided from. */
interface StepContext {
  job: JobState;
  approval: Approval;
  resolution: Resolution;
  progress: AttemptProgress;
  wc: WorkingCopy;
  /** The Job's latest event: whatever this step does, it happens because of it. */
  cause: string | null;
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
    const running = new Map<string, { repo: string; done: Promise<void> }>();
    for (;;) {
      let moved = false;
      for (const job of this.queue(running)) {
        const plan = await this.plan(job);
        if (!plan) continue;
        if (plan.kind === "instant") {
          await plan.run();
          moved = true;
          break; // the queue may look different now
        }
        const inRepo = [...running.values()].filter((r) => r.repo === job.repo).length;
        if (running.size >= this.deps.config.current.max_running || inRepo >= plan.repoLimit) continue;
        const done = plan.run().finally(() => running.delete(job.job_id));
        running.set(job.job_id, { repo: job.repo, done });
        moved = true;
      }
      if (moved) continue;
      if (!running.size) return;
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
    const issue = item.kind === "approved" ? item.issue.number : item.issue;
    const live = this.deps.log.jobs().find((j) => j.repo === item.repo && j.issue === issue && isLive(j));
    if (item.kind === "unapproved") {
      if (live) {
        await this.record({ type: "job-cancelled", job_id: live.job_id, actor: `human:${item.by}`, data: { reason: "ready label removed" } });
        await this.deps.workspace.removeJob(live.job_id);
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
    const wc = await this.deps.workspace.startAttempt({ repo: item.repo, job_id, attempt: 1, branch });
    await this.record({ type: "attempt-started", job_id, attempt: 1, actor: "orchestrator", caused_by: approval.id, data: { branch, base: wc.base } });
  }

  private async plan(job: JobState): Promise<Plan | null> {
    // Edits to factory.yaml apply at the next Stage run (ADR 0005).
    if (this.deps.config.refresh().changed) {
      await this.record({ type: "config-reloaded", actor: "orchestrator", data: { config_hash: this.deps.config.hash } });
    }
    const ctx = this.context(job);
    const base = { job_id: job.job_id, attempt: job.attempt, caused_by: ctx.cause };

    if (ctx.resolution.errors.length) {
      return instant(() => this.askHuman(job, { kind: "question", cause: "cannot-start", text: ctx.resolution.errors.join("\n") }, ctx.cause));
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
    return { kind: "stage-run", repoLimit: ctx.resolution.maxRunning, run: () => this.runStage(ctx, stage) };
  }

  private context(job: JobState): StepContext {
    const events = this.deps.log.eventsFor(job.job_id);
    const approval = approvalOf(events);
    const resolution = resolve(this.deps.config.current, { repo: job.repo, labels: approval.labels });
    const attemptEvents = events.filter((e) => e.attempt === job.attempt);
    const started = attemptEvents.find((e) => e.type === "attempt-started")!;
    const wc = this.deps.workspace.workingCopy({
      repo: job.repo,
      job_id: job.job_id,
      attempt: job.attempt,
      branch: String(started.data.branch),
      base: String(started.data.base),
    });
    const progress = attemptProgress(attemptEvents, resolution.stages.map((s) => s.id));
    return { job, approval, resolution, progress, wc, cause: events.at(-1)?.id ?? null };
  }

  private async runStage(ctx: StepContext, stage: ResolvedStage): Promise<void> {
    const stage_run_id = ulid();
    const started = await this.record({
      job_id: ctx.job.job_id,
      attempt: ctx.job.attempt,
      stage_run_id,
      actor: "orchestrator",
      caused_by: ctx.cause,
      type: "stage-started",
      data: { stage: stage.id, config_hash: this.deps.config.hash },
    });
    const run = { job_id: ctx.job.job_id, attempt: ctx.job.attempt, stage_run_id, actor: `stage:${stage.id}` as const, caused_by: started.id };
    const outcome = stage.kind === "check" ? await this.runCheck(ctx, stage, stage_run_id) : await this.runAgent(ctx, stage, stage_run_id, run);
    if (outcome.kind !== "stopped") await this.conclude(ctx, stage, outcome, run);
  }

  private async runAgent(ctx: StepContext, stage: ResolvedStage, stage_run_id: string, run: RunEnvelope): Promise<StageOutcome> {
    const { job, wc, progress } = ctx;
    const brief: StageBrief = {
      stage: stage.id,
      instructions: stage.instructions!,
      tools: stage.tools!,
      repo: job.repo,
      issue: { number: job.issue, title: ctx.approval.title, body: ctx.approval.body },
      branch: wc.branch,
      workingCopy: wc.repo,
      attempt: job.attempt,
      bounce: progress.bounces,
      earlier: progress.earlier,
      conventions: await this.deps.workspace.conventions(wc),
    };
    const outcome = await this.deps.agent.run({
      stage_run_id,
      brief,
      renderedBrief: renderBrief(brief),
      model: stage.model!,
      workingCopy: { dir: wc.repo, env: wc.env },
      budget: ctx.resolution.policies.budgets.stage_run,
      resultSchema: STAGE_RESULT_SCHEMA,
    });
    if (outcome.kind === "error") return outcome;
    const parsed = parseStageResult(outcome.output);
    if (!parsed.ok) return { kind: "error", reason: "invalid-result", message: parsed.errors.join("; "), facts: outcome.facts };

    const pushed = await this.pushAgentWork(ctx, stage, run);
    if (!pushed) return { kind: "stopped" };
    return { kind: "result", result: parsed.result, facts: { ...outcome.facts, ...pushed } };
  }

  /**
   * Fetches what the agent committed into quarantine, runs the Pre-push checks and, if
   * they pass, pushes from the Trusted clone. Returns the measured head and changed
   * files, or null when a check failed (recorded, and the Job sent to a human).
   */
  private async pushAgentWork(ctx: StepContext, stage: ResolvedStage, run: RunEnvelope): Promise<Pick<MeasuredFacts, "head" | "files_changed"> | null> {
    const { wc, progress } = ctx;
    const before = progress.pushedHead ?? wc.base;
    const incoming = await this.deps.workspace.receive(wc);
    const failures = await this.deps.prePush.run(wc, incoming, { before, profile: stage.tools! });
    if (failures.length) {
      const failed = await this.record({ ...run, type: "prepush-failed", data: { check: failures[0]!.check, failures } });
      await this.askHuman(ctx.job, { kind: "approval", cause: "prepush-failed", text: failures.map((f) => f.message).join("\n") }, failed.id);
      return null;
    }
    const head = incoming.head!;
    if (head === before) return { head, files_changed: [] };
    const files_changed = await this.deps.workspace.filesChanged(incoming, before, head);
    await this.deps.workspace.push(wc, incoming, { remoteHead: progress.pushedHead });
    await this.record({ ...run, actor: "orchestrator", type: "branch-pushed", data: { branch: wc.branch, before, head } });
    return { head, files_changed };
  }

  /** Runs a Check Stage in a fresh checkout of exactly the pushed head, so its result is about that commit. */
  private async runCheck(ctx: StepContext, stage: ResolvedStage, stage_run_id: string): Promise<StageOutcome> {
    const head = ctx.progress.pushedHead ?? ctx.wc.base;
    const startedAt = Date.now();
    const dir = await this.deps.workspace.checkout(ctx.wc, head, stage_run_id);
    let run;
    try {
      run = await this.deps.checks.run({ commands: stage.commands!, cwd: dir, env: ctx.wc.env });
    } finally {
      this.deps.workspace.removeCheckout(dir);
    }
    const output = this.deps.artifacts.put(run.output);
    const facts = { cost_usd: 0, duration_ms: Date.now() - startedAt, head };
    if (run.passed) {
      const summary = `All ${stage.commands!.length} command(s) passed.`;
      return { kind: "result", result: { verdict: "pass", summary, findings: [], artifacts: [] }, facts, extra: { output } };
    }
    const failed = run.failed!;
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
      extra: { output },
    };
  }

  /** Records how the Stage run ended and where the Pipeline goes next. */
  private async conclude(ctx: StepContext, stage: ResolvedStage, outcome: Exclude<StageOutcome, { kind: "stopped" }>, run: RunEnvelope): Promise<void> {
    const { job, progress, resolution } = ctx;
    if (outcome.kind === "error") {
      const errored = await this.record({
        ...run,
        type: "stage-errored",
        data: { stage: stage.id, reason: outcome.reason, message: outcome.message, ...outcome.facts },
      });
      // Retrying Run errors comes in #27; until then a human decides.
      await this.askHuman(job, { kind: "approval", cause: "run-error", text: `${stage.id} ${outcome.reason}: ${outcome.message}` }, errored.id);
      return;
    }

    const { result } = outcome;
    const data = { stage: stage.id, result, ...outcome.facts, ...outcome.extra };
    if (result.verdict === "pass") {
      await this.record({ ...run, type: "stage-passed", data });
      return;
    }
    if (result.verdict === "needs-human") {
      const asked = await this.record({ ...run, type: "stage-needs-human", data: { ...data, question: result.question!.text, options: result.question!.options } });
      await this.askHuman(job, { kind: "question", text: result.question!.text, options: result.question!.options }, asked.id);
      return;
    }

    const failed = await this.record({ ...run, type: "stage-failed", data: { ...data, summary: result.summary } });
    const repeated = result.findings.filter((f) => progress.bouncedRootCauses.has(f.root_cause)).map((f) => f.root_cause);
    if (!stage.on_fail) {
      await this.askHuman(job, { kind: "approval", cause: "no-bounce-target", text: `${stage.id} failed and has no on_fail Stage. ${result.summary}` }, failed.id);
    } else if (progress.bounces >= resolution.policies.bounce_cap) {
      await this.askHuman(job, { kind: "approval", cause: "bounce-cap", text: `${stage.id} failed after ${progress.bounces} Bounces (cap ${resolution.policies.bounce_cap}). ${result.summary}` }, failed.id);
    } else if (repeated.length) {
      await this.askHuman(job, { kind: "approval", cause: "repeated-root-cause", text: `${stage.id} failed again for the same root cause: ${[...new Set(repeated)].join(", ")}.` }, failed.id);
    } else {
      await this.record({
        job_id: job.job_id,
        attempt: job.attempt,
        actor: "orchestrator",
        caused_by: failed.id,
        type: "bounced",
        data: { from: stage.id, to: stage.on_fail, bounce: progress.bounces + 1 },
      });
    }
  }

  private async askHuman(job: JobState, data: { kind: "question" | "approval"; cause?: string; text: string; options?: string[] }, caused_by: string | null) {
    await this.record({ type: "human-requested", job_id: job.job_id, attempt: job.attempt, actor: "orchestrator", caused_by, data });
  }

  /** Records one event and hands it to every Mirror. A Mirror failing never blocks a Job (ADR 0002). */
  private async record(event: NewEvent): Promise<FactoryEvent> {
    const recorded = this.deps.log.record(event);
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
    return recorded;
  }
}

type RunEnvelope = Pick<NewEvent, "job_id" | "attempt" | "stage_run_id" | "actor" | "caused_by">;

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
