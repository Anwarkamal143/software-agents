import { describe, expect, test } from "vitest";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryEvent } from "../src/events/envelope.js";
import { TokenAuth } from "../src/github/auth.js";
import { GitHubClient } from "../src/github/client.js";
import { FACTORY_MARKER } from "../src/humans/commands.js";
import type { JobState } from "../src/jobs/projection.js";
import { GitHubMirror } from "../src/mirror/github.js";
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
  const client = new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch: github.fetch, sleep: async () => {} });
  const mirror = new GitHubMirror({ client, dir, schedule: (_run, ms) => void scheduled.push(ms) });
  const comments = (n = ISSUE) => (github.comments.get(`${REPO}#${n}`) ?? []).map((c) => c.body);
  const statusComments = () => comments().filter((b) => b.includes("factory:status"));
  return { github, client, mirror, dir, scheduled, comments, statusComments };
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
});
