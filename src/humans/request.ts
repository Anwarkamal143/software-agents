import type { FactoryEvent } from "../events/envelope.js";
import { ASK_CAUSES } from "../policies/merge-gate.js";
import { FACTORY_MARKER } from "./commands.js";

const LETTERS = ["A", "B", "C"] as const;
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
  const question = clean(String(d.text ?? ""), MAX_QUESTION);
  const lines = [FACTORY_MARKER, `<!-- factory:job=${job} request=${event.id} -->`];

  let options: string[];
  let replies: string[];
  let local: string[];
  if (d.kind === "question") {
    const given = ((d.options as string[] | undefined) ?? []).slice(0, LETTERS.length);
    lines.push(`**The Factory needs an answer** · Stage \`${stage}\` · Job \`${job}\``);
    options = [
      ...given.map((o, i) => `- **${LETTERS[i]}.** ${clean(o, MAX_OPTION)}: ${stage} carries on with this answer.`),
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

function approveConsequence(cause: string, stage: string): string {
  if (MERGE_CAUSES.has(cause)) return "the Factory merges once the Merge gate's fixed core passes; /approve never overrides it.";
  if (cause === "bounce-cap") return `${stage} Bounces once more, past the cap.`;
  if (cause === "repeated-root-cause") return `${stage} Bounces once more, despite the repeated root cause.`;
  return `${stage} runs again.`;
}

/**
 * Agent-written text the Factory posts: capped, with Factory markers defused and @mentions
 * and Reply commands set in code, so the post neither pings anyone nor reads as a command.
 */
export function clean(text: string, max: number): string {
  const capped = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return capped
    .replaceAll("<!--", "&lt;!--")
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)/g, "$1`@$2`")
    .replace(/(^|[^\w/`])(\/(?:answer|approve|reject|cancel))\b/g, "$1`$2`");
}
