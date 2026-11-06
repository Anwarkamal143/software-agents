import type { FactoryEvent } from "../events/envelope.js";
import type { EarlierResult } from "../stages/brief.js";
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
  /** The Merge gate checkpoint has already been recorded. */
  atMergeGate: boolean;
}

const ENDINGS = new Set(["stage-passed", "stage-failed", "stage-needs-human", "stage-skipped"]);

export function attemptProgress(events: FactoryEvent[], stages: string[]): AttemptProgress {
  const progress: AttemptProgress = {
    next: 0,
    bounces: 0,
    bouncedRootCauses: new Set(),
    earlier: [],
    filesChanged: new Set(),
    atMergeGate: false,
  };
  let lastFailure: Finding[] = [];
  for (const e of events) {
    const stage = typeof e.data.stage === "string" ? e.data.stage : null;
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
    if ((e.type === "stage-passed" || e.type === "stage-skipped") && stage) progress.next = stages.indexOf(stage) + 1;
    if (e.type === "stage-failed") lastFailure = (e.data.result as StageResult | undefined)?.findings ?? [];
    if (e.type === "bounced") {
      progress.bounces++;
      progress.next = stages.indexOf(String(e.data.to));
      for (const f of lastFailure) progress.bouncedRootCauses.add(f.root_cause);
    }
    if (e.type === "checkpoint-evaluated" && e.data.checkpoint === "merge-gate") progress.atMergeGate = true;
  }
  return progress;
}
