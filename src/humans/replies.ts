import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import type { EventLog } from "../jobs/event-log.js";
import type { ReplyCommand } from "./commands.js";

/** One Reply command, from a GitHub comment or the local `factory` CLI. */
export interface Reply {
  job_id: string;
  channel: "github" | "cli";
  /** The GitHub login that wrote the comment. The CLI is whoever runs it on this machine. */
  by?: string;
  /** When the comment was created (edits don't move it); for the CLI, now. */
  created_at: string;
  comment_id?: string;
  command: ReplyCommand;
}

/** Who may reply on GitHub: the `humans` allowlist, and whether the sender has write access now (ADR 0007). */
export interface ReplyAccess {
  humans: string[];
  writeAccess: boolean;
}

export type IgnoredWhy =
  | "not-allowed"
  | "no-write-access"
  | "edited-after-recording"
  | "not-waiting"
  | "before-request"
  | "already-answered"
  | "wrong-command"
  | "no-such-option"
  | "malformed";

export type ReplyOutcome = { kind: "answered"; event: FactoryEvent } | { kind: "ignored"; why: IgnoredWhy; event: FactoryEvent };

/** Which commands answer which kind of Human request. `/cancel` answers both. */
const ANSWERS = { question: ["answer", "cancel"], approval: ["approve", "reject", "cancel"] } as const;
const LETTERS = ["A", "B", "C"];

/**
 * Decides whether a Reply command answers the Job's open Human request, and records the
 * answer (`human-answered`) or why it doesn't count (`reply-ignored`). Decided and recorded
 * under the Job store's write lock, so the first reply recorded wins across processes.
 * GitHub replies need `access`; the CLI is the machine's owner.
 */
export function recordReply(log: EventLog, reply: Reply, access?: ReplyAccess): ReplyOutcome {
  return log.exclusive(() => {
    const events = log.eventsFor(reply.job_id);
    const request = events.findLast((e) => e.type === "human-requested");
    const envelope = {
      job_id: reply.job_id,
      attempt: request?.attempt ?? events.at(-1)?.attempt ?? null,
      actor: reply.channel === "github" ? (`human:${reply.by}` as const) : ("cli" as const),
      caused_by: request?.id ?? null,
    };
    const source = { channel: reply.channel, ...(reply.by && { by: reply.by }), ...(reply.comment_id && { comment_id: reply.comment_id }) };
    const ignore = (why: IgnoredWhy): ReplyOutcome => ({
      kind: "ignored",
      why,
      event: log.record({ ...envelope, type: "reply-ignored", data: { why, command: reply.command.command, ...(request && { request: request.id }), ...source } }),
    });

    if (reply.channel === "github") {
      if (!access || !reply.by || !access.humans.includes(reply.by)) return ignore("not-allowed");
      if (!access.writeAccess) return ignore("no-write-access");
      if (reply.comment_id && events.some((e) => e.type === "human-answered" && e.data.comment_id === reply.comment_id)) {
        return ignore("edited-after-recording");
      }
    }
    if (!request) return ignore("not-waiting");
    if (Date.parse(reply.created_at) < Date.parse(request.at)) return ignore("before-request");
    if (events.some((e) => e.type === "human-answered" && e.seq > request.seq)) return ignore("already-answered");
    if (log.job(reply.job_id)?.status !== "waiting") return ignore("not-waiting");

    const kind = request.data.kind as keyof typeof ANSWERS;
    const { command } = reply;
    if (!(ANSWERS[kind] as readonly string[]).includes(command.command)) return ignore("wrong-command");
    let text: string | undefined;
    if (command.command === "answer") {
      const options = (request.data.options as string[] | undefined) ?? [];
      if (command.option === "other") text = command.text;
      else {
        text = options[LETTERS.indexOf(command.option)];
        if (text === undefined) return ignore("no-such-option");
      }
    } else if (command.command === "reject") text = command.text;

    const answered: NewEvent = {
      ...envelope,
      type: "human-answered",
      data: { command: command.command, ...(command.command === "answer" && { option: command.option }), ...(text !== undefined && { text }), request: request.id, ...source },
    };
    return { kind: "answered", event: log.record(answered) };
  });
}

/** Logs a comment that looked like a Reply command but didn't parse. */
export function recordMalformedReply(log: EventLog, reply: Omit<Reply, "command">, detail: string): FactoryEvent {
  const last = log.eventsFor(reply.job_id).at(-1);
  return log.record({
    job_id: reply.job_id,
    attempt: last?.attempt ?? null,
    actor: reply.channel === "github" ? `human:${reply.by}` : "cli",
    type: "reply-ignored",
    data: { why: "malformed", detail, channel: reply.channel, ...(reply.by && { by: reply.by }), ...(reply.comment_id && { comment_id: reply.comment_id }) },
  });
}
