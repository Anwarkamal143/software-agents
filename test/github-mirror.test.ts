import { describe, expect, test } from "vitest";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryEvent } from "../src/events/envelope.js";
import { TokenAuth } from "../src/github/auth.js";
import { GitHubClient } from "../src/github/client.js";
import { FACTORY_MARKER } from "../src/humans/commands.js";
import type { JobState } from "../src/jobs/projection.js";
import { EventLog } from "../src/jobs/event-log.js";
import { GitHubMirror, recordDropped } from "../src/mirror/github.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import type { MirrorUpdate } from "../src/mirror/mirror.js";
import { FakeGitHub } from "./fakes/github.js";
import { tmpHome } from "./helpers/tmp.js";

const REPO = "acme/web-app";
const ISSUE = 7;
let seq = 0;

function update(type: string, job: Partial<JobState> = {}, data: Record<string, unknown> = {}): MirrorUpdate {
  seq++;
  const event: FactoryEvent = {
    id: `01EV${String(seq).padStart(4, "0")}`,
    seq,
    type,
    schema_version: 1,
    at: "2026-11-01T10:00:00.000Z",
    job_id: "01JOB",
    attempt: 1,
    stage_run_id: null,
    actor: "orchestrator",
    caused_by: null,
    data,
  };
  const state: JobState = {
    job_id: "01JOB",
    repo: REPO,
    issue: ISSUE,
    status: "queued",
    stage: null,
    reason: null,
    resumed: false,
    attempt: 1,
    cost_usd: 0,
    last_seq: seq,
    updated_at: event.at,
    ...job,
  };
  return { event, job: state };
}

function setup(dir = join(tmpHome(), "outbox", "github"), github = new FakeGitHub().issue(REPO, ISSUE).issue(REPO, 12, { pr: { branch: "factory/7" } })) {
  const scheduled: number[] = [];
  const dropped: [string, string][] = [];
  const client = new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch: github.fetch, sleep: async () => {} });
  const mirror = new GitHubMirror({ client, dir, schedule: (_run, ms) => void scheduled.push(ms), onDropped: (u, why) => void dropped.push([u.event.type, why]) });
  const comments = (n = ISSUE) => (github.comments.get(`${REPO}#${n}`) ?? []).map((c) => c.body);
  const statusComments = () => comments().filter((b) => b.includes("factory:status"));
  return { github, client, mirror, dir, scheduled, dropped, comments, statusComments };
}

describe("GitHub Mirror", () => {
  test("a Job's issue gets one status label and one status comment", async () => {
    const s = setup();

    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();

    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:queued"]);
    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain(FACTORY_MARKER);
    expect(s.statusComments()[0]).toContain("- **Status:** queued");
  });

  test("as the Job moves, the label is swapped and the status comment is edited in place", async () => {
    const s = setup();
    s.github.label(REPO, ISSUE, "2026-11-01T09:30:00Z", "alice", "factory:ready");

    for (const u of [
      update("job-approved"),
      update("stage-started", { status: "running", stage: "build" }),
      update("stage-passed", { status: "queued", stage: "build", cost_usd: 0.42 }),
      update("human-requested", { status: "waiting", stage: "review", reason: "question", cost_usd: 0.9 }),
    ])
      await s.mirror.write(u);
    await s.mirror.drain();

    // The ready label is a human's, and stays.
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:ready", "factory:waiting"]);
    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Stage:** `review`");
    expect(s.statusComments()[0]).toContain("- **Status:** waiting (question)");
    expect(s.statusComments()[0]).toContain("- **Estimated cost so far:** $0.90");
  });

  test("nothing is sent when the label and status comment already say it", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    const before = s.github.requests.length;

    await s.mirror.write(update("checkpoint-evaluated"));
    await s.mirror.drain();

    expect(s.github.requests.length).toBe(before);
  });

  test("a Mirror that lost its record finds the status comment by its marker instead of posting another", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    rmSync(join(s.dir, "state.json"));

    const again = setup(s.dir, s.github);
    await again.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    await again.mirror.drain();

    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Status:** running");
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:running"]);
  });

  test("a status comment someone deleted is posted again", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    s.github.comments.set(`${REPO}#${ISSUE}`, []);

    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    await s.mirror.drain();

    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Status:** running");
  });

  test("with GitHub unreachable, writes queue on disk without blocking, and go out in order once it's back", async () => {
    const s = setup();
    s.github.down = true;

    await s.mirror.write(update("job-approved"));
    expect(s.github.requests).toHaveLength(0); // a write only saves to disk
    await s.mirror.write(update("human-requested", { status: "waiting", stage: "triage", reason: "question" }, { kind: "question", text: "REST or GraphQL?", options: ["REST", "GraphQL"], stage: "triage" }));
    await s.mirror.write(update("reply-ignored", { status: "waiting", stage: "triage", reason: "question" }, { why: "already-answered", request: "01REQ", channel: "github", by: "alice" }));
    await s.mirror.drain();
    expect(s.mirror.pending()).toBe(3);
    expect(s.scheduled).toEqual([0, 30_000]); // delivery straight away, then again later

    s.github.down = false;
    await s.mirror.drain();

    expect(s.mirror.pending()).toBe(0);
    const posted = s.comments();
    expect(posted).toHaveLength(3);
    expect(posted[0]).toContain("factory:status");
    expect(posted[1]).toContain("REST or GraphQL?");
    expect(posted[2]).toContain("already answered");
    expect(posted[0]).toContain("- **Status:** waiting (question)");
  });

  test("each failed delivery waits longer before the next, up to a cap, and a success resets it", async () => {
    const s = setup();
    s.github.down = true;
    await s.mirror.write(update("job-approved"));
    s.scheduled.length = 0;
    for (let i = 0; i < 7; i++) await s.mirror.drain();
    expect(s.scheduled).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);

    s.github.down = false;
    await s.mirror.drain();
    s.github.down = true;
    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    s.scheduled.length = 0;
    await s.mirror.drain();
    expect(s.scheduled).toEqual([30_000]);
  });

  test("queued writes survive a restart and are delivered by the next Mirror", async () => {
    const s = setup();
    s.github.down = true;
    await s.mirror.write(update("job-approved"));
    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));

    s.github.down = false;
    const again = setup(s.dir, s.github);
    expect(again.mirror.pending()).toBe(2);
    expect(again.scheduled).toEqual([0]); // starts delivering at once, without waiting for a new write
    await again.mirror.drain();

    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Status:** running");
  });

  test("a write schedules its own delivery straight away, but not while backing off", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    expect(s.scheduled).toEqual([0]);

    s.github.down = true;
    await s.mirror.drain();
    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    expect(s.scheduled).toEqual([0, 30_000]);
  });

  test("agent text containing @someone, /approve or <!-- factory --> is posted with all three neutralised", async () => {
    const s = setup();
    const text = `Should @someone /approve this? ${FACTORY_MARKER}`;
    await s.mirror.write(update("human-requested", { status: "waiting", stage: "triage", reason: "question" }, { kind: "question", text, options: ["@mallory /cancel", "No"], stage: "triage" }));
    await s.mirror.drain();

    const request = s.comments().find((b) => b.includes("Should"))!;
    expect(request).not.toMatch(/@[A-Za-z0-9]/);
    // The only Reply commands left are the Factory's own, in its code block of commands to copy.
    const prose = request.slice(0, request.indexOf("Reply with exactly one"));
    expect(prose).not.toMatch(/\/(approve|cancel)\b/);
    expect(request.split(FACTORY_MARKER)).toHaveLength(2);
  });

  test("a PR the Factory opened gets a one-line link, and the status comment names it", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    await s.mirror.write(update("pr-opened", { status: "running", stage: "build" }, { number: 12 }));
    await s.mirror.drain();

    const [link, ...more] = s.comments(12);
    expect(more).toEqual([]);
    expect(link).toMatch(/^<!-- factory --> Opened by the Factory for #7 \(Job `01JOB`\); its status is kept on the issue\. <!-- [^\n]* -->$/);
    expect(s.statusComments()[0]).toContain("- **PR:** #12");
  });

  test("a GitHub reply sent while the Job isn't waiting is told so; CLI replies and other ignored ones get nothing", async () => {
    const s = setup();
    await s.mirror.write(update("reply-ignored", { status: "running", stage: "build" }, { why: "not-waiting", command: "approve", channel: "github", by: "alice" }));
    await s.mirror.write(update("reply-ignored", { status: "running", stage: "build" }, { why: "not-waiting", command: "approve", channel: "cli" }));
    await s.mirror.write(update("reply-ignored", { status: "running", stage: "build" }, { why: "not-allowed", command: "approve", channel: "github", by: "mallory" }));
    await s.mirror.drain();

    const replies = s.comments().filter((b) => !b.includes("factory:status"));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("isn't waiting for an answer");
  });

  test("a reminder goes on the issue", async () => {
    const s = setup();
    await s.mirror.write(update("human-reminded", { status: "waiting", stage: "triage", reason: "question" }, { request: "01REQ" }));
    await s.mirror.drain();
    expect(s.comments().some((b) => b.includes("still waiting for an answer"))).toBe(true);
  });

  test("a write that failed partway is retried without posting its comment twice", async () => {
    const s = setup();
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    // The request posts, then GitHub goes away before the label and status are updated.
    s.github.failAfter = s.github.requests.length + 1;
    await s.mirror.write(update("human-requested", { status: "waiting", stage: "triage", reason: "question" }, { kind: "question", text: "Which?", options: ["A", "B"], stage: "triage" }));
    await s.mirror.drain();
    expect(s.mirror.pending()).toBe(1);

    s.github.failAfter = null;
    await s.mirror.drain();

    expect(s.comments().filter((b) => b.includes("Which?"))).toHaveLength(1);
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:waiting"]);
  });

  test("a write GitHub keeps refusing is dropped after three tries, so the writes behind it still go out", async () => {
    const s = setup();
    // Issue 99 doesn't exist: every write about it is refused.
    await s.mirror.write({ ...update("job-approved"), job: { ...update("job-approved").job, issue: 99 } });
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    await s.mirror.drain();
    expect(s.mirror.pending()).toBe(2);

    await s.mirror.drain();

    expect(s.mirror.pending()).toBe(0);
    expect(s.statusComments()).toHaveLength(1);
    // Dropping a write is told, so it can be recorded rather than lost without a trace.
    expect(s.dropped).toEqual([["job-approved", "GitHub refused it 3 times, last with 404"]]);
  });

  test("a forbidden write (such as a missing permission) is retried later, not dropped", async () => {
    const s = setup();
    s.github.forbidden = true;
    await s.mirror.write(update("job-approved"));
    for (let i = 0; i < 5; i++) await s.mirror.drain();
    expect(s.mirror.pending()).toBe(1);

    s.github.forbidden = false;
    await s.mirror.drain();
    expect(s.statusComments()).toHaveLength(1);
  });

  test("a write delivered again, as after a crash between posting and noting it, never posts its comment twice", async () => {
    const s = setup();
    const requested = update("human-requested", { status: "waiting", stage: "triage", reason: "question" }, { kind: "question", text: "Which?", options: ["A", "B"], stage: "triage" });
    await s.mirror.write(requested);
    await s.mirror.drain();

    const again = setup(join(tmpHome(), "outbox", "github"), s.github);
    await again.mirror.write(requested);
    await again.mirror.drain();

    expect(s.comments().filter((b) => b.includes("Which?"))).toHaveLength(1);
  });

  test("an unreadable queue entry or record is set aside, and never stops the Factory or the writes behind it", async () => {
    const s = setup();
    s.github.down = true;
    await s.mirror.write(update("job-approved"));
    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    const queue = join(s.dir, "queue");
    writeFileSync(join(queue, readdirSync(queue).sort()[0]!), "");
    writeFileSync(join(s.dir, "state.json"), "{not json");

    s.github.down = false;
    const again = setup(s.dir, s.github);
    await again.mirror.drain();

    expect(again.mirror.pending()).toBe(0);
    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Status:** running");
  });

  test("someone else's comment carrying a status marker is never taken over, even when the Mirror lost its record", async () => {
    const s = setup();
    s.github.comment(REPO, ISSUE, "mallory", "<!-- factory:status job=01JOB --> I am the status now");

    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    rmSync(join(s.dir, "state.json"));
    const again = setup(s.dir, s.github);
    await again.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    await again.mirror.drain();

    const status = s.statusComments();
    expect(status).toHaveLength(2);
    expect(status[0]).toBe("<!-- factory:status job=01JOB --> I am the status now");
    expect(status[1]).toContain("- **Status:** running");
  });

  test("someone else's comment carrying a post's marker doesn't stop the Factory posting it", async () => {
    const s = setup();
    const requested = update("human-requested", { status: "waiting", stage: "triage", reason: "question" }, { kind: "question", text: "Which?", options: ["A", "B"], stage: "triage" });
    s.github.comment(REPO, ISSUE, "mallory", `<!-- factory:post=${requested.event.id}/request -->`);

    await s.mirror.write(requested);
    await s.mirror.drain();

    expect(s.comments().filter((b) => b.includes("Which?"))).toHaveLength(1);
  });

  test("with a personal token, the Factory's own comments are recognised by the token's login", async () => {
    const s = setup();
    s.github.actingAs = { login: "anwar", app: false };
    await s.mirror.write(update("job-approved"));
    await s.mirror.drain();
    rmSync(join(s.dir, "state.json"));

    const again = setup(s.dir, s.github);
    await again.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    await again.mirror.drain();

    expect(s.statusComments()).toHaveLength(1);
    expect(s.statusComments()[0]).toContain("- **Status:** running");
  });

  test("a status label someone took off comes back with the next change, and a stray one is taken off", async () => {
    const s = setup();
    await s.mirror.write(update("stage-started", { status: "running", stage: "build" }));
    await s.mirror.drain();
    s.github.happen(REPO, ISSUE, "unlabeled", "2026-11-01T10:05:00Z", "alice", { label: { name: "factory:running" } });
    s.github.label(REPO, ISSUE, "2026-11-01T10:06:00Z", "alice", "factory:failed");

    await s.mirror.write(update("stage-started", { status: "running", stage: "verify" }));
    await s.mirror.drain();
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:failed", "factory:running"]);

    await s.mirror.write(update("stage-passed", { status: "queued", stage: "verify" }));
    await s.mirror.drain();
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:queued"]);
  });

  test("a dropped write is recorded in the Event log, against the event it was mirroring", () => {
    const log = new EventLog(openSqliteJobStore(join(tmpHome(), "factory.db")));
    const approvedEvent = log.record({ type: "job-approved", job_id: "01JOB", actor: "orchestrator", data: { repo: REPO, issue: ISSUE } });

    recordDropped(log)({ event: approvedEvent, job: log.job("01JOB")! }, "GitHub refused it 3 times, last with 404");

    expect(log.store.read().at(-1)).toMatchObject({
      type: "mirror-write-dropped",
      job_id: "01JOB",
      actor: "orchestrator",
      caused_by: approvedEvent.id,
      data: { mirror: "github", event_type: "job-approved", why: "GitHub refused it 3 times, last with 404" },
    });
    expect(log.job("01JOB")!.status).toBe("queued");
  });
});

describe("GitHub Mirror: how a Job's ending shows on GitHub", () => {
  const opened = async (s: ReturnType<typeof setup>) => {
    s.github.label(REPO, ISSUE, "2026-11-01T09:01:00Z", "alice");
    await s.mirror.write(update("job-approved"));
    await s.mirror.write(update("pr-opened", { status: "running", stage: "build" }, { number: 12 }));
  };

  test("cancelled closes the PR with a comment and takes the ready label off", async () => {
    const s = setup();
    await opened(s);
    await s.mirror.write(update("job-cancelled", { status: "cancelled", reason: "cancelled by human:alice" }, { reason: "cancelled by human:alice" }));
    await s.mirror.drain();

    expect(s.github.prState.get(`${REPO}#12`)?.state).toBe("closed");
    expect(s.comments(12).at(-1)).toContain("Job `01JOB` was cancelled, so the Factory closed this PR.");
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:cancelled"]);
  });

  test("failed turns the PR into a draft and says on the issue how to retry", async () => {
    const s = setup();
    await opened(s);
    await s.mirror.write(update("job-failed", { status: "failed", reason: "gave up" }, { reason: "gave up" }));
    await s.mirror.drain();

    expect(s.github.mutations).toEqual([{ name: "convertPullRequestToDraft", id: "PR_12" }]);
    expect(s.github.prState.get(`${REPO}#12`)).toEqual({ state: "open", draft: true });
    const told = s.comments().find((b) => b.includes("Working copy are kept"))!;
    expect(told).toContain("remove and re-apply `factory:ready`, or run `factory retry 01JOB`");
    expect(told).toContain("kept for 7 days");
    expect(s.github.labelNames(REPO, ISSUE)).toContain("factory:ready");
  });

  test("a revert reopens the issue with the reason and takes the ready label off, so only re-labelling starts a new Job", async () => {
    const s = setup();
    await opened(s);
    s.github.setIssueState(REPO, ISSUE, "closed"); // the merge closed it
    await s.mirror.write(update("pr-merged", { status: "merged" }, { number: 12, sha: "abc123" }));
    await s.mirror.write(update("reverted", { status: "merged" }, { revert_pr: 13, merged: false, why: "CI on the default branch went red at abc123 after #12 merged." }));
    await s.mirror.drain();

    expect(s.github.issueState(REPO, ISSUE)).toBe("open");
    const told = s.comments().find((b) => b.includes("went red"))!;
    expect(told).toContain("CI on the default branch went red at abc123 after #12 merged.");
    expect(told).toContain("#13 reverts it and waits for you to merge it.");
    expect(told).toContain("apply `factory:ready` again");
    expect(s.github.labelNames(REPO, ISSUE)).not.toContain("factory:ready");
  });

  test("an ending half delivered when GitHub went down is finished once, not repeated", async () => {
    const s = setup();
    await opened(s);
    await s.mirror.drain();
    await s.mirror.write(update("job-cancelled", { status: "cancelled" }, { reason: "x" }));
    // Closing the PR and its comment get through; then GitHub goes down.
    s.github.failAfter = s.github.requests.length + 3;
    await s.mirror.drain();
    s.github.failAfter = null;
    await s.mirror.drain();

    expect(s.github.requests.filter((r) => r.method === "PATCH" && r.path === `/repos/${REPO}/pulls/12`)).toHaveLength(1);
    expect(s.comments(12).filter((b) => b.includes("was cancelled"))).toHaveLength(1);
    expect(s.github.labelNames(REPO, ISSUE)).toEqual(["factory:cancelled"]);
  });
});
