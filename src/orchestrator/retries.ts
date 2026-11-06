import type { SessionResume } from "../agents/adapter.js";
import type { FactoryEvent } from "../events/envelope.js";
import { BROKEN_ENDINGS, STAGE_RUN_ENDINGS } from "../jobs/endings.js";

/**
 * Run error retries (ADR 0010), read from one Attempt's events alone, so a restarted
 * Orchestrator decides the same. A Stage gets up to 2 retries per Attempt, resumes included.
 */
export const MAX_RETRIES = 2;

/** Why a Run error went to a human; `/approve` on such a request gives the Stage one more try. */
export type RetryCause = "retries-exhausted" | "repeated-run-error";
const RETRY_CAUSES: ReadonlySet<string> = new Set<RetryCause>(["retries-exhausted", "repeated-run-error"]);

export interface RetryAsk {
  cause: RetryCause;
  text: string;
}

/** How the next run of a Stage starts after its last run broke. */
export type RetryRun =
  /** Resume the broken session with `input` as its next turn. */
  | (SessionResume & { kind: "resume"; retry_of: string })
  | { kind: "fresh"; retry_of: string };

/** Reasons whose session is resumed once before the Stage starts fresh. */
const RESUME_ONCE = new Set(["crash", "sdk-error"]);

/**
 * Whether the Run error just recorded for `stage` goes to a human rather than being retried:
 * retries have run out, the same reason struck in the same place twice, or this was the one
 * more try a human approved. A `budget` Run error never gets here: it pauses the Job.
 */
export function afterRunError(events: FactoryEvent[], stage: string): RetryAsk | null {
  const { errors, approvedOneMore } = runErrorsCounted(events, stage);
  const last = errors.at(-1);
  if (!last) return null;
  const what = `${stage} ${String(last.data.reason)}: ${String(last.data.message ?? "")}`;
  if (approvedOneMore) return { cause: "retries-exhausted", text: `${what}\nThe one more try you approved broke too.` };
  const previous = errors.at(-2);
  if (previous && place(previous) === place(last)) {
    return { cause: "repeated-run-error", text: `${what}\nThe same Run error happened twice in a row, so the remaining retries are skipped.` };
  }
  if (errors.length > MAX_RETRIES) return { cause: "retries-exhausted", text: `${what}\n${stage} broke ${errors.length} times; its ${MAX_RETRIES} retries are used up.` };
  return null;
}

/**
 * How the next run of `stage` starts, if its last run broke: `crash` / `sdk-error` resume
 * the session once, then start fresh; `invalid-result` resumes with the schema errors as a
 * correction turn; `timeout` starts fresh. A run cut off by a restart resumes once, then reruns.
 * Null when the last run didn't break, so the Stage just runs.
 */
export function retryRun(events: FactoryEvent[], stage: string): RetryRun | null {
  const runs = events.filter((e) => (e.type === "stage-started" || e.type === "stage-resumed") && e.data.stage === stage);
  const lastRun = runs.at(-1);
  if (!lastRun) return null;
  const ending = events.find((e) => e.stage_run_id === lastRun.stage_run_id && STAGE_RUN_ENDINGS.has(e.type));
  if (!ending || !BROKEN_ENDINGS.has(ending.type)) return null;
  const fresh: RetryRun = { kind: "fresh", retry_of: ending.id };
  const session_id = typeof ending.data.session_id === "string" ? ending.data.session_id : null;
  // A Factory fault, plan limit or Guard denials ended the run: it starts over once released.
  if (ending.type === "stage-interrupted" && ending.data.reason !== undefined) return fresh;
  if (!session_id) return fresh;
  const reason = ending.type === "stage-interrupted" ? "interrupted" : String(ending.data.reason);
  // Was the run that broke already the one resume this reason gets?
  const retried = events.find((e) => e.id === lastRun.data.retry_of);
  const resumedFor = lastRun.type === "stage-resumed" && retried ? (retried.type === "stage-interrupted" ? "interrupted" : String(retried.data.reason)) : null;
  if (reason === "invalid-result") {
    return { kind: "resume", session_id, input: correctionTurn(String(ending.data.message ?? "")), retry_of: ending.id };
  }
  if ((RESUME_ONCE.has(reason) || reason === "interrupted") && resumedFor !== reason) {
    return { kind: "resume", session_id, input: carryOnTurn(reason), retry_of: ending.id };
  }
  return fresh;
}


/**
 * The Stage's counted Run errors: since the latest `/approve` of a retry request for it, if
 * there is one, else the whole Attempt. A `budget` Run error is never retried, so never counted.
 */
function runErrorsCounted(events: FactoryEvent[], stage: string): { errors: FactoryEvent[]; approvedOneMore: boolean } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const approvedAt = events.findLastIndex((e) => {
    if (e.type !== "human-answered" || e.data.command !== "approve") return false;
    const request = byId.get(String(e.data.request));
    return request !== undefined && RETRY_CAUSES.has(String(request.data.cause)) && request.data.stage === stage;
  });
  const errors = events.slice(approvedAt + 1).filter((e) => e.type === "stage-errored" && e.data.stage === stage && e.data.reason !== "budget");
  return { errors, approvedOneMore: approvedAt !== -1 };
}

/** Where a Run error struck: the same reason with the same message (failing command, schema errors) is the same place. */
const place = (e: FactoryEvent) => `${String(e.data.reason)}\0${String(e.data.where ?? e.data.message ?? "")}`;

function correctionTurn(errors: string): string {
  return [
    "Your structured output didn't match the Stage result schema, so the Factory couldn't accept it:",
    "",
    ...errors.split("; ").map((e) => `- ${e}`),
    "",
    "Don't redo the work. End this turn with a Stage result that matches the schema.",
  ].join("\n");
}

function carryOnTurn(reason: string): string {
  const why = reason === "interrupted" ? "The Factory restarted while this session was running." : `This session stopped unexpectedly (${reason}).`;
  return `${why} Carry on from where you stopped, then end with your Stage result.`;
}
