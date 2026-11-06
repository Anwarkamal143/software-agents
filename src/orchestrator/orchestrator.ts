import { createHash } from "node:crypto";
import picomatch from "picomatch";
import { ulid } from "ulid";
import type { AgentAdapter, MeasuredFacts } from "../agents/adapter.js";
import type { ConfigHolder } from "../config/holder.js";
import { resolve, type Resolution, type ResolvedStage } from "../config/resolve.js";
import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { EventLog } from "../jobs/event-log.js";
import type { JobState } from "../jobs/projection.js";
import type { Mirror } from "../mirror/mirror.js";
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
  /** Where a Job's Stage runs work. Working copies come in #28. */
  workdir: (job: JobState) => string;
  /** The Target repo's CLAUDE.md or AGENTS.md text. */
  conventions: (job: JobState) => string;
}

/** The approved issue, as recorded on `job-approved`. */
interface Approval {
  title: string;
  body: string;
  labels: string[];
}

type StageOutcome =
  | { kind: "result"; result: StageResult; facts: Partial<MeasuredFacts>; extra?: Record<string, unknown> }
  | { kind: "error"; reason: string; message: string; facts: Partial<MeasuredFacts> };

/**
 * Owns Job state, Stage order and every write (ADR 0001). Each step is decided
 * from the Event log and config alone; Verdicts only route the Pipeline (ADR 0003).
 */
export class Orchestrator {
  private cursor: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Polls the Source once, then advances Jobs until none can move without something new happening. */
  async runUntilIdle(): Promise<void> {
    await this.poll();
    while (await this.step()) {
      // keep going
    }
  }

  private async poll(): Promise<void> {
    const { items, cursor } = await this.deps.source.poll(this.cursor);
    for (const item of items) await this.admit(item);
    this.cursor = cursor;
  }

  private async admit(item: SourceItem): Promise<void> {
    const live = this.deps.log
      .jobs()
      .find((j) => j.repo === item.repo && j.issue === (item.kind === "approved" ? item.issue.number : item.issue) && isLive(j));
    if (item.kind === "unapproved") {
      if (live) await this.record({ type: "job-cancelled", job_id: live.job_id, actor: `human:${item.by}`, data: { reason: "ready label removed" } });
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
    await this.record({
      type: "attempt-started",
      job_id,
      attempt: 1,
      actor: "orchestrator",
      caused_by: approval.id,
      data: { branch: `factory/${item.issue.number}` },
    });
  }

  /** Advances the first queued Job that can move by one Stage run. Returns false when none can. */
  private async step(): Promise<boolean> {
    for (const job of this.deps.log.jobs()) {
      if (job.status === "queued" && (await this.advance(job))) return true;
    }
    return false;
  }

  private async advance(job: JobState): Promise<boolean> {
    // Edits to factory.yaml apply at the next Stage run (ADR 0005).
    const reload = this.deps.config.refresh();
    if (reload.changed) await this.record({ type: "config-reloaded", actor: "orchestrator", data: { config_hash: this.deps.config.hash } });

    const events = this.jobEvents(job);
    const approval = approvalOf(events);
    const resolution = resolve(this.deps.config.current, { repo: job.repo, labels: approval.labels });
    const attemptEvents = events.filter((e) => e.attempt === job.attempt);
    const ids = resolution.stages.map((s) => s.id);
    const progress = attemptProgress(attemptEvents, ids);
    // Whatever this step does, it happens because of the Job's latest event.
    const base = { job_id: job.job_id, attempt: job.attempt, caused_by: events.at(-1)?.id ?? null };

    if (resolution.errors.length) {
      await this.askHuman(job, { kind: "question", cause: "cannot-start", text: resolution.errors.join("\n") }, base.caused_by ?? undefined);
      return true;
    }
    const stage = resolution.stages[progress.next];
    if (!stage) {
      if (progress.atMergeGate) return false;
      // Merge gate decisions come in #25; this Job has reached the checkpoint.
      await this.record({ ...base, type: "checkpoint-evaluated", actor: "orchestrator", data: { checkpoint: "merge-gate" } });
      return true;
    }

    if (stage.when && !conditionHolds(stage, approval.labels, progress.filesChanged)) {
      await this.record({ ...base, type: "stage-skipped", actor: "orchestrator", data: { stage: stage.id, why: describeCondition(stage) } });
      return true;
    }

    const stage_run_id = ulid();
    const runBase = { ...base, stage_run_id, actor: `stage:${stage.id}` as const };
    const started = await this.record({
      ...runBase,
      actor: "orchestrator",
      type: "stage-started",
      data: { stage: stage.id, config_hash: this.deps.config.hash },
    });
    const outcome =
      stage.kind === "check"
        ? await this.runCheck(job, stage)
        : await this.runAgent(job, stage, stage_run_id, approval, progress, resolution);
    await this.conclude(job, stage, outcome, progress, resolution, { ...runBase, caused_by: started.id });
    return true;
  }

  private async runAgent(
    job: JobState,
    stage: ResolvedStage,
    stage_run_id: string,
    approval: Approval,
    progress: AttemptProgress,
    resolution: Resolution,
  ): Promise<StageOutcome> {
    const brief: StageBrief = {
      stage: stage.id,
      instructions: stage.instructions!,
      tools: stage.tools!,
      repo: job.repo,
      issue: { number: job.issue, title: approval.title, body: approval.body },
      branch: this.branch(job),
      attempt: job.attempt,
      bounce: progress.bounces,
      earlier: progress.earlier,
      conventions: this.deps.conventions(job),
    };
    const outcome = await this.deps.agent.run({
      stage_run_id,
      brief,
      prompt: renderBrief(brief),
      model: stage.model!,
      budget: resolution.policies.budgets.stage_run,
      resultSchema: STAGE_RESULT_SCHEMA,
    });
    if (outcome.kind === "error") return outcome;
    const parsed = parseStageResult(outcome.output);
    if (!parsed.ok) {
      return { kind: "error", reason: "invalid-result", message: parsed.errors.join("; "), facts: outcome.facts };
    }
    return { kind: "result", result: parsed.result, facts: outcome.facts };
  }

  private async runCheck(job: JobState, stage: ResolvedStage): Promise<StageOutcome> {
    const started = Date.now();
    const run = await this.deps.checks.run({ commands: stage.commands!, cwd: this.deps.workdir(job) });
    const output = this.deps.artifacts.put(run.output);
    const facts = { cost_usd: 0, duration_ms: Date.now() - started };
    if (run.passed) {
      const summary = `All ${stage.commands!.length} command(s) passed.`;
      return { kind: "result", result: { verdict: "pass", summary, findings: [], artifacts: [] }, facts, extra: { output } };
    }
    const failed = run.failed!;
    const how = failed.timed_out ? "timed out" : `exited ${failed.exit_code}`;
    // The same command failing with the same output is the same root cause; different output is progress.
    const digest = createHash("sha256").update(run.output).digest("hex").slice(0, 12);
    return {
      kind: "result",
      result: {
        verdict: "fail",
        summary: `\`${failed.command}\` ${how}.`,
        findings: [{ severity: "error", message: `\`${failed.command}\` ${how}.`, root_cause: `check:${stage.id}:${failed.command}:${digest}` }],
        artifacts: [],
      },
      facts,
      extra: { output },
    };
  }

  /** Records how the Stage run ended and where the Pipeline goes next. */
  private async conclude(
    job: JobState,
    stage: ResolvedStage,
    outcome: StageOutcome,
    progress: AttemptProgress,
    resolution: Resolution,
    run: Pick<NewEvent, "job_id" | "attempt" | "stage_run_id" | "actor" | "caused_by">,
  ): Promise<void> {
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

  private async askHuman(job: JobState, data: { kind: "question" | "approval"; cause?: string; text: string; options?: string[] }, caused_by?: string) {
    await this.record({ type: "human-requested", job_id: job.job_id, attempt: job.attempt, actor: "orchestrator", caused_by: caused_by ?? null, data });
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

  private jobEvents(job: JobState): FactoryEvent[] {
    return this.deps.log.store.read().filter((e) => e.job_id === job.job_id);
  }

  private branch(job: JobState): string {
    return job.attempt > 1 ? `factory/${job.issue}-a${job.attempt}` : `factory/${job.issue}`;
  }
}

const isLive = (j: JobState) => !["merged", "failed", "cancelled"].includes(j.status);

function approvalOf(events: FactoryEvent[]): Approval {
  const data = events.find((e) => e.type === "job-approved")?.data ?? {};
  return {
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    labels: Array.isArray(data.labels) ? (data.labels as string[]) : [],
  };
}

function conditionHolds(stage: ResolvedStage, labels: string[], filesChanged: Set<string>): boolean {
  const { labels: wanted = [], paths = [] } = stage.when ?? {};
  if (wanted.some((l) => labels.includes(l))) return true;
  const matches = paths.length ? picomatch(paths, { dot: true }) : null;
  return matches !== null && [...filesChanged].some((f) => matches(f));
}

function describeCondition(stage: ResolvedStage): string {
  const parts = [];
  if (stage.when?.labels) parts.push(`no label in [${stage.when.labels.join(", ")}]`);
  if (stage.when?.paths) parts.push(`no changed file matches [${stage.when.paths.join(", ")}]`);
  return `when: ${parts.join(" and ")}`;
}
