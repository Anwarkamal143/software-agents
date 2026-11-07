import type { FactoryEvent } from "../events/envelope.js";
import type { EarlierResult, HumanAnswer } from "../stages/brief.js";
import type { Finding, StageResult } from "../stages/result.js";

/**
 * Where one Attempt stands in its Pipeline, read from that Attempt's events.
 * Derived from the Event log alone, so a restarted Orchestrator gets the same answer.
 */
export interface AttemptProgress {
  /** Index of the next Stage to run; `>= stages.length` once every Stage has passed or been skipped. */
  next: number;
  bounces: number;
  /** Root-cause keys of findings that have already caused a Bounce. */
  bouncedRootCauses: Set<string>;
  /** Results of every Stage run that ended in this Attempt, oldest first. */
  earlier: EarlierResult[];
  /** Union of files changed by this Attempt's Stage runs. */
  filesChanged: Set<string>;
  /** The Job branch as last pushed, or null before the first push. */
  pushedHead: string | null;
  /** Every question a Stage asked in this Attempt that a human has answered. */
  answers: HumanAnswer[];
  /** An answer the asking Stage hasn't run with yet. */
  pendingAnswer: PendingAnswer | null;
}

export interface PendingAnswer {
  answer: HumanAnswer;
  /** The human-answered event. */
  answered: string;
  /** The session that asked, to resume; absent if the adapter gave none. */
  session_id?: string;
  /** When the session that asked started. */
  sessionStartedAt: string;
}

const ENDINGS = new Set(["stage-passed", "stage-failed", "stage-needs-human", "stage-skipped"]);

export function attemptProgress(events: FactoryEvent[], stages: string[]): AttemptProgress {
  const progress: AttemptProgress = {
    next: 0,
    bounces: 0,
    bouncedRootCauses: new Set(),
    earlier: [],
    filesChanged: new Set(),
    pushedHead: null,
    answers: [],
    pendingAnswer: null,
  };
  let lastFailure: Finding[] = [];
  const startedAt = new Map<string, string>();
  /** The latest question a Stage asked, until it's answered or the Stage runs again. */
  let asked: { stage: string; question: string; options: string[]; session_id?: string; startedAt: string } | null = null;
  for (const e of events) {
    const stage = typeof e.data.stage === "string" ? e.data.stage : null;
    if (e.type === "stage-started" || e.type === "stage-resumed") {
      // A resumed session is as old as the session it resumed.
      if (e.stage_run_id) startedAt.set(e.stage_run_id, e.type === "stage-resumed" ? (progress.pendingAnswer?.sessionStartedAt ?? e.at) : e.at);
      progress.pendingAnswer = null;
      asked = null;
    }
    if (e.type === "stage-needs-human" && stage) {
      asked = {
        stage,
        question: String(e.data.question ?? ""),
        options: (e.data.options as string[] | undefined) ?? [],
        ...(typeof e.data.session_id === "string" && { session_id: e.data.session_id }),
        startedAt: (e.stage_run_id && startedAt.get(e.stage_run_id)) || e.at,
      };
    }
    if (e.type === "human-answered") {
      progress.pendingAnswer = null;
      if (e.data.command === "answer" && asked) {
        const answer: HumanAnswer = {
          stage: asked.stage,
          question: asked.question,
          options: asked.options,
          answer: String(e.data.text ?? ""),
          by: e.actor,
          channel: e.data.channel === "github" ? "github" : "cli",
        };
        progress.answers.push(answer);
        progress.pendingAnswer = { answer, answered: e.id, ...(asked.session_id && { session_id: asked.session_id }), sessionStartedAt: asked.startedAt };
      }
      asked = null;
    }
    if (ENDINGS.has(e.type) && stage) {
      const result = e.data.result as StageResult | undefined;
      progress.earlier.push({
        stage,
        verdict: e.type === "stage-skipped" ? "skipped" : (result?.verdict ?? "fail"),
        summary: result?.summary ?? String(e.data.why ?? ""),
        findings: result?.findings ?? [],
      });
      for (const file of (e.data.files_changed as string[] | undefined) ?? []) progress.filesChanged.add(file);
    }
    // A Check Stage passing again on a rebased head never sends the Pipeline back to the Stages after it.
    if ((e.type === "stage-passed" || e.type === "stage-skipped") && stage) progress.next = Math.max(progress.next, stages.indexOf(stage) + 1);
    if (e.type === "stage-failed") lastFailure = (e.data.result as StageResult | undefined)?.findings ?? [];
    if (e.type === "bounced") {
      progress.bounces++;
      progress.next = stages.indexOf(String(e.data.to));
      const rejected = e.data.finding as Finding | undefined;
      const own = e.data.findings as Finding[] | undefined;
      if (rejected) {
        // A /reject: the human's reason is the finding, not the last Stage failure's.
        progress.earlier.push({ stage: "human", verdict: "fail", summary: `${e.actor} rejected the work at ${String(e.data.from)}.`, findings: [rejected] });
      } else if (own) {
        // A Bounce from the Merge gate, such as a rebase conflict: it is its own failure.
        progress.earlier.push({ stage: String(e.data.from), verdict: "fail", summary: String(e.data.summary ?? ""), findings: own });
        for (const f of own) progress.bouncedRootCauses.add(f.root_cause);
      } else for (const f of lastFailure) progress.bouncedRootCauses.add(f.root_cause);
      lastFailure = [];
    }
    if (e.type === "branch-pushed" || (e.type === "rebased" && typeof e.data.head === "string")) progress.pushedHead = String(e.data.head);
  }
  return progress;
}
