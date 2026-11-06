import { describe, expect, test } from "vitest";
import { join } from "node:path";
import type { ReplyCommand } from "../src/humans/commands.js";
import { recordReply, type Reply } from "../src/humans/replies.js";
import { EventLog } from "../src/jobs/event-log.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { jobLog } from "./fixtures/logs.js";
import { tmpHome } from "./helpers/tmp.js";

const ASKED_AT = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-01T11:00:00.000Z";
const access = { humans: ["alice", "bob"], writeAccess: true };

/** A Job waiting on a Human request of `kind`, asked at ASKED_AT. */
function waitingLog(kind: "question" | "approval", path = join(tmpHome(), "factory.db")) {
  const log = new EventLog(openSqliteJobStore(path));
  for (const e of jobLog("job-1", [
    ["job-approved", { repo: "acme/web-app", issue: 7 }],
    ["attempt-started", { branch: "factory/7" }],
    ["stage-started", { stage: "triage" }],
    kind === "question"
      ? ["stage-needs-human", { stage: "triage", question: "REST or GraphQL?", options: ["REST", "GraphQL"] }]
      : ["stage-failed", { stage: "triage", summary: "Nope." }],
  ])) {
    log.record(e);
  }
  const options = kind === "question" ? { options: ["REST", "GraphQL"] } : {};
  const request = log.record({ type: "human-requested", job_id: "job-1", attempt: 1, actor: "orchestrator", at: ASKED_AT, data: { kind, stage: "triage", text: "REST or GraphQL?", ...options } });
  return { log, path, request };
}

const github = (command: ReplyCommand, over: Partial<Reply> = {}): Reply => ({
  job_id: "job-1",
  channel: "github",
  by: "alice",
  created_at: LATER,
  comment_id: "c-1",
  command,
  ...over,
});
const cli = (command: ReplyCommand): Reply => ({ job_id: "job-1", channel: "cli", created_at: LATER, command });

describe("recordReply", () => {
  test("an answer from someone on humans is recorded as human-answered, naming its channel and the request", () => {
    const { log, request } = waitingLog("question");

    const outcome = recordReply(log, github({ command: "answer", option: "B" }), access);

    expect(outcome.kind).toBe("answered");
    expect(outcome.event).toMatchObject({
      type: "human-answered",
      actor: "human:alice",
      caused_by: request.id,
      data: { command: "answer", option: "B", text: "GraphQL", request: request.id, channel: "github", comment_id: "c-1" },
    });
    expect(log.job("job-1")).toMatchObject({ status: "queued" });
  });

  test("other: carries the human's own text", () => {
    const { log } = waitingLog("question");
    const outcome = recordReply(log, cli({ command: "answer", option: "other", text: "gRPC" }));
    expect(outcome.event).toMatchObject({ actor: "cli", data: { command: "answer", option: "other", text: "gRPC", channel: "cli" } });
  });

  test.each<[string, Reply, typeof access | undefined, string]>([
    ["someone not on humans", github({ command: "approve" }, { by: "mallory" }), access, "not-allowed"],
    ["someone on humans who lost write access", github({ command: "approve" }), { ...access, writeAccess: false }, "no-write-access"],
    ["a comment written before the request", github({ command: "approve" }, { created_at: "2026-11-01T09:59:59.000Z" }), access, "before-request"],
    ["/answer to an approval", github({ command: "answer", option: "A" }), access, "wrong-command"],
  ])("a command from %s is ignored and logged", (_, reply, acc, why) => {
    const { log } = waitingLog("approval");

    const outcome = recordReply(log, reply, acc);

    expect(outcome).toMatchObject({ kind: "ignored", why });
    expect(outcome.event).toMatchObject({ type: "reply-ignored", job_id: "job-1", data: { why, channel: "github", command: reply.command.command } });
    expect(log.job("job-1")).toMatchObject({ status: "waiting" });
  });

  test("/approve to a question, or an option the question doesn't have, is ignored", () => {
    const { log } = waitingLog("question");
    expect(recordReply(log, github({ command: "approve" }), access)).toMatchObject({ kind: "ignored", why: "wrong-command" });
    expect(recordReply(log, github({ command: "answer", option: "C" }), access)).toMatchObject({ kind: "ignored", why: "no-such-option" });
    expect(log.job("job-1")).toMatchObject({ status: "waiting" });
  });

  test("a command for a Job that isn't waiting is ignored", () => {
    const { log } = waitingLog("approval");
    log.record({ type: "job-cancelled", job_id: "job-1", attempt: 1, actor: "cli", data: { reason: "gone" } });
    expect(recordReply(log, cli({ command: "approve" }))).toMatchObject({ kind: "ignored", why: "not-waiting" });
  });

  test("the first recorded reply wins; a later one is told the request was already answered", () => {
    const { log } = waitingLog("approval");

    const first = recordReply(log, cli({ command: "approve" }));
    const second = recordReply(log, github({ command: "reject", text: "No." }, { comment_id: "c-2" }), access);

    expect(first.kind).toBe("answered");
    expect(second).toMatchObject({ kind: "ignored", why: "already-answered" });
    expect(log.store.read().filter((e) => e.type === "human-answered")).toHaveLength(1);
  });

  test("a GitHub reply and a CLI reply through separate Job store connections: the first recorded wins", () => {
    const orchestratorSide = waitingLog("approval");
    // The CLI opens its own connection, and its own Event log, on the same Job store.
    const cliSide = new EventLog(openSqliteJobStore(orchestratorSide.path));
    expect(cliSide.job("job-1")).toMatchObject({ status: "waiting" });

    expect(recordReply(orchestratorSide.log, github({ command: "approve" }), access).kind).toBe("answered");
    expect(recordReply(cliSide, cli({ command: "cancel" }))).toMatchObject({ kind: "ignored", why: "already-answered" });
    expect(cliSide.job("job-1")).toMatchObject({ status: "queued" });
  });

  test("an edit to a comment already recorded changes nothing, and gets no second reply", () => {
    const { log } = waitingLog("question");
    recordReply(log, github({ command: "answer", option: "A" }), access);

    const edited = recordReply(log, github({ command: "answer", option: "B" }), access);

    expect(edited).toMatchObject({ kind: "ignored", why: "edited-after-recording" });
    expect(log.store.read().find((e) => e.type === "human-answered")?.data.option).toBe("A");
  });

  test("a reply already told it came too late isn't told again when it's edited", () => {
    const { log } = waitingLog("approval");
    recordReply(log, cli({ command: "approve" }));
    expect(recordReply(log, github({ command: "cancel" }, { comment_id: "c-2" }), access)).toMatchObject({ why: "already-answered" });

    expect(recordReply(log, github({ command: "approve" }, { comment_id: "c-2" }), access)).toMatchObject({ why: "edited-after-recording" });
  });

  test("an answer to a new request must come after that request, not just the first one", () => {
    const { log } = waitingLog("question");
    recordReply(log, github({ command: "answer", option: "A" }), access);
    log.record({ type: "stage-started", job_id: "job-1", attempt: 1, actor: "orchestrator", data: { stage: "triage" } });
    log.record({ type: "stage-needs-human", job_id: "job-1", attempt: 1, actor: "orchestrator", data: { stage: "triage", question: "Sure?", options: ["Yes", "No"] } });
    log.record({ type: "human-requested", job_id: "job-1", attempt: 1, actor: "orchestrator", at: "2026-11-02T10:00:00.000Z", data: { kind: "question", text: "Sure?", options: ["Yes", "No"] } });

    const stale = recordReply(log, github({ command: "answer", option: "B" }, { comment_id: "c-9", created_at: "2026-11-01T12:00:00.000Z" }), access);

    expect(stale).toMatchObject({ kind: "ignored", why: "before-request" });
  });
});
