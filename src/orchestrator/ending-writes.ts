import type { FactoryEvent } from "../events/envelope.js";

/** One change a Job's ending makes to GitHub, and the event that records it done. */
export type EndingWrite =
  | { kind: "close-pr"; number: number }
  | { kind: "draft-pr"; number: number }
  | { kind: "remove-ready-label"; label: string }
  | { kind: "reopen-issue" };

/** The event type that records each kind of write done (or refused outright). */
export const RECORDED_AS: Record<EndingWrite["kind"], string> = {
  "close-pr": "pr-closed",
  "draft-pr": "pr-drafted",
  "remove-ready-label": "ready-label-removed",
  "reopen-issue": "issue-reopened",
};

/**
 * What the Job's ending still owes GitHub (ADR 0010), from its events alone, so a write GitHub
 * couldn't take is simply owed again on the next pass. Cancelled: every PR the Job opened is
 * closed and the ready label comes off. Failed: the last Attempt's PR goes back to a draft. A
 * reverted merge: the issue is reopened and the ready label comes off, so only re-labelling starts
 * the next Job. A Job that is live again owes nothing.
 */
export function endingWrites(events: FactoryEvent[], readyLabel: string): EndingWrite[] {
  const ending = events.findLast((e) => e.type === "job-cancelled" || e.type === "job-failed" || e.type === "reverted" || e.type === "job-retried" || e.type === "attempt-started");
  if (!ending || ending.type === "job-retried" || ending.type === "attempt-started") return [];
  const since = events.filter((e) => e.seq > ending.seq);
  const done = (type: string, match: (e: FactoryEvent) => boolean = () => true) => since.some((e) => e.type === type && e.actor === "orchestrator" && match(e));
  const prs = events.filter((e) => e.type === "pr-opened").map((e) => ({ number: Number(e.data.number), attempt: e.attempt }));
  const unlabel: EndingWrite[] = done("ready-label-removed") ? [] : [{ kind: "remove-ready-label", label: readyLabel }];

  if (ending.type === "job-cancelled") {
    // A PR already closed or merged, by anyone, needs nothing.
    const settled = new Set(events.filter((e) => (e.type === "pr-closed" || e.type === "pr-merged") && typeof e.data.number === "number").map((e) => e.data.number));
    return [...prs.filter((p) => !settled.has(p.number)).map((p): EndingWrite => ({ kind: "close-pr", number: p.number })), ...unlabel];
  }
  if (ending.type === "job-failed") {
    const pr = prs.findLast((p) => p.attempt === ending.attempt);
    return pr && !done("pr-drafted", (e) => e.data.number === pr.number) ? [{ kind: "draft-pr", number: pr.number }] : [];
  }
  return [...(done("issue-reopened") ? [] : [{ kind: "reopen-issue" } as const]), ...unlabel];
}
