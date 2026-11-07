import type { FactoryEvent } from "../events/envelope.js";
import { ASK_CAUSES } from "../policies/merge-gate.js";
import { cleanAgentText } from "../mirror/clean.js";
import { FACTORY_MARKER, OPTION_LETTERS as LETTERS } from "./commands.js";
const MAX_QUESTION = 2000;
const MAX_OPTION = 500;

/** Causes an `/approve` answers at the Merge gate: approving lets the Factory merge, never past the gate core. */
const MERGE_CAUSES = new Set<string>(ASK_CAUSES);

/**
 * A Human request as a Mirror posts it (ADR 0006): the Stage, the question, lettered options
 * with what each one does, the exact Reply commands to copy, and a hidden Factory marker
 * with the Job id. Agent-written text in it is cleaned first (ADR 0007).
 */
export function renderHumanRequest(event: FactoryEvent): string {
  const job = event.job_id!;
  const d = event.data;
  const stage = typeof d.stage === "string" ? d.stage : "the Stage";
  const question = cleanAgentText(String(d.text ?? ""), MAX_QUESTION);
  const lines = [FACTORY_MARKER, `<!-- factory:job=${job} request=${event.id} -->`];

  let options: string[];
  let replies: string[];
  let local: string[];
  if (d.kind === "question") {
    const given = ((d.options as string[] | undefined) ?? []).slice(0, LETTERS.length);
    lines.push(`**The Factory needs an answer** · Stage \`${stage}\` · Job \`${job}\``);
    options = [
      ...given.map((o, i) => `- **${LETTERS[i]}.** ${cleanAgentText(o, MAX_OPTION)}: ${stage} carries on with this answer.`),
      `- **other: <text>**: ${stage} carries on with your own answer.`,
    ];
    const answers = [...given.map((_, i) => LETTERS[i]!), "other: <text>"];
    replies = [...answers.map((a) => `/answer ${a}`), "/cancel"];
    local = [...answers.map((a) => `factory answer ${job} ${a}`), `factory cancel ${job}`];
  } else {
    const cause = String(d.cause ?? "");
    const rejectTo = typeof d.reject_to === "string" ? d.reject_to : "build";
    lines.push(`**The Factory needs a decision** · Stage \`${stage}\` · Job \`${job}\``);
    options = [
      `- **A.** \`/approve\`: ${approveConsequence(cause, stage)}`,
      `- **B.** \`/reject <reason>\`: the Job Bounces to ${rejectTo} with your reason as a finding.`,
      "- **C.** `/cancel`: the Job is cancelled: its PR closed and its branches deleted.",
    ];
    replies = ["/approve", "/reject <reason>", "/cancel"];
    local = [`factory approve ${job}`, `factory reject ${job} <reason>`, `factory cancel ${job}`];
  }

  lines.push("", question, "", ...options, "");
  lines.push("Reply with exactly one of these (only people on `humans` with write access count):", "", "```", ...replies, "```", "");
  lines.push("Or on the Factory's machine:", "", "```", ...local, "```", "");
  return lines.join("\n");
}

/**
 * The reply a Mirror posts to a Reply command that came after the request was already
 * answered (`reply-ignored` with why `already-answered`). It never repeats the late command.
 */
export function renderAlreadyAnswered(ignored: FactoryEvent): string {
  return [
    FACTORY_MARKER,
    `<!-- factory:job=${ignored.job_id} request=${String(ignored.data.request ?? "")} -->`,
    `This request was already answered, so this reply changes nothing. The first answer recorded wins; see \`factory events\` for Job \`${ignored.job_id}\`.`,
    "",
  ].join("\n");
}

/** The reply a Mirror posts to a Reply command sent while the Job wasn't waiting (`reply-ignored` with why `not-waiting`). */
export function renderNotWaiting(ignored: FactoryEvent): string {
  return [FACTORY_MARKER, `This Job isn't waiting for an answer, so this reply changes nothing. See \`factory status\` for Job \`${ignored.job_id}\`.`, ""].join("\n");
}

/** The reminder a Mirror posts once a Human request has gone unanswered for three days. */
export function renderReminder(reminded: FactoryEvent): string {
  return [
    FACTORY_MARKER,
    `<!-- factory:job=${reminded.job_id} request=${String(reminded.data.request ?? "")} -->`,
    `Job \`${reminded.job_id}\` is still waiting for an answer to the request above. Nothing happens until someone replies.`,
    "",
  ].join("\n");
}

function approveConsequence(cause: string, stage: string): string {
  if (MERGE_CAUSES.has(cause)) return "the Factory merges once the Merge gate's fixed core passes; /approve never overrides it.";
  if (cause === "reapproval") return "the edited issue counts as approved, and the Job carries on with it.";
  if (cause === "bounce-cap") return `${stage} Bounces once more, past the cap.`;
  if (cause === "repeated-root-cause") return `${stage} Bounces once more, despite the repeated root cause.`;
  return `${stage} runs again.`;
}
