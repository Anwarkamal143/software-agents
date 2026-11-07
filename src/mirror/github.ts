import { join } from "node:path";
import { GitHubError, type GitHubClient } from "../github/client.js";
import { FACTORY_MARKER } from "../humans/commands.js";
import { renderAlreadyAnswered, renderHumanRequest, renderNotWaiting, renderReminder } from "../humans/request.js";
import type { EventLog } from "../jobs/event-log.js";
import type { JobState } from "../jobs/projection.js";
import type { Mirror, MirrorUpdate } from "./mirror.js";
import { Outbox, readJson, writeAtomic, type OutboxEntry } from "./outbox.js";
import { cleanAgentText } from "./clean.js";
import { renderPrLink, renderStatusComment, STATUS_LABELS, statusLabel, statusMarker } from "./status.js";

export interface GitHubMirrorOptions {
  client: GitHubClient;
  /** Where the outbox and what the Mirror knows of each issue are kept. */
  dir: string;
  /** Runs `run` after `ms`. Defaults to a timer that never keeps the process alive. */
  schedule?: (run: () => void, ms: number) => void;
  /** Milliseconds since the epoch; backoff is timed from it. */
  now?: () => number;
  /** The label that approves a Job, named in what an ending tells you to do next. Read at each delivery. */
  readyLabel?: () => string;
  /** Told about each write dropped after GitHub kept refusing it, so it can be recorded. */
  onDropped?: (update: MirrorUpdate, why: string) => void;
}

/** A comment as GitHub lists it: enough to tell whether the Factory wrote it. */
interface Comment {
  id: number;
  body?: string;
  user?: { login: string } | null;
  performed_via_github_app?: unknown;
}

/** After a failed delivery, wait this long before the next, doubling up to the cap. */
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/**
 * A write GitHub refuses as wrong in itself (the issue is gone, the request is invalid) is dropped
 * after this many tries, so it can't hold up the rest. Anything else, a 403 for a missing
 * permission included, is waited out: it would refuse every write alike.
 */
const MAX_REFUSALS = 3;
const REFUSED = new Set([400, 404, 410, 422]);

/** One comment an event asks for, beyond the status label and comment. */
interface Post {
  part: "request" | "reminder" | "reply" | "pr-link" | "ending";
  /** The issue or PR it goes on. */
  number: number;
  body: string;
}

/** What the Mirror last wrote for one Job's issue, so it edits rather than duplicates. */
interface Written {
  label?: string;
  comment?: number;
  body?: string;
  pr?: { number: number };
}

interface MirrorState {
  v: 1;
  /** The login the Factory's comments appear under: its App's bot, or a personal token's owner. */
  self?: string;
  jobs: Record<string, Written>;
}

/**
 * The GitHub Mirror (ADR 0002): a status label and one status comment per Job's issue, kept up
 * to date through an outbox on disk. It never decides anything, and a write only saves to disk,
 * so GitHub being down never blocks a Job.
 */
export class GitHubMirror implements Mirror {
  private readonly outbox: Outbox<MirrorUpdate>;
  private readonly statePath: string;
  private state: MirrorState;
  private readonly now: () => number;
  private backoffMs = 0;
  private backoffUntil = 0;
  /** The drain already scheduled, if any; `token` tells a stale timer it was superseded. */
  private wake: { at: number; token: number } | null = null;
  private tokens = 0;
  private draining: Promise<void> | null = null;
  /** Asked GitHub who the Factory is, this process. */
  private askedWho = false;

  constructor(private readonly options: GitHubMirrorOptions) {
    this.outbox = new Outbox(join(options.dir, "queue"));
    this.statePath = join(options.dir, "state.json");
    this.now = options.now ?? Date.now;
    // Losing the record only costs lookups: the status comment is found again by its marker.
    this.state = readJson<MirrorState>(this.statePath) ?? { v: 1, jobs: {} };
    // Writes left over from before a restart go out without waiting for a new one.
    if (this.outbox.size()) this.kick(0);
  }

  /** Only saves the write to disk; delivery happens in the background. */
  async write(update: MirrorUpdate): Promise<void> {
    this.outbox.add(update);
    this.kick(Math.max(0, this.backoffUntil - this.now()));
  }

  /** Writes saved and not yet delivered. */
  pending(): number {
    return this.outbox.size();
  }

  /**
   * Delivers queued writes, oldest first, until the queue is empty or a delivery fails; then
   * tries again after a backoff. Only one drain runs at a time.
   */
  drain(): Promise<void> {
    this.wake = null;
    this.draining ??= this.drainOnce().finally(() => (this.draining = null));
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    try {
      for (let head = this.outbox.head(); head; head = this.outbox.head()) {
        try {
          await this.deliver(head.name, head.entry);
        } catch (err) {
          if (!(err instanceof GitHubError && REFUSED.has(err.status))) throw err;
          if (++head.entry.refusals < MAX_REFUSALS) {
            this.outbox.save(head.name, head.entry);
            throw err;
          }
          this.dropped(head.entry.item, `GitHub refused it ${MAX_REFUSALS} times, last with ${err.status}`);
        }
        this.outbox.remove(head.name);
        this.backoffMs = 0;
        this.backoffUntil = 0;
      }
    } catch {
      // Unreachable, refused for now, or the disk misbehaving: whatever it was, try again later.
      this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + this.backoffMs;
      this.kick(this.backoffMs);
    }
  }

  /** Makes sure a drain runs within `ms`. */
  private kick(ms: number): void {
    const at = this.now() + ms;
    if (this.wake && this.wake.at <= at) return;
    const token = ++this.tokens;
    this.wake = { at, token };
    const schedule = this.options.schedule ?? ((run, wait) => setTimeout(run, wait).unref());
    schedule(() => {
      if (this.wake?.token === token) void this.drain();
    }, ms);
  }

  private async deliver(name: string, entry: OutboxEntry<MirrorUpdate>): Promise<void> {
    const { event, job } = entry.item;
    if (event.type === "pr-opened" && typeof event.data.number === "number") {
      this.written(job.job_id).pr = { number: event.data.number };
      this.saveState();
    }
    for (const post of [...posts(entry.item), ...this.endingPosts(entry.item)]) {
      if (entry.done.includes(post.part)) continue;
      // Posted already, by a process that died before it could note so: find it rather than post another.
      const marker = `<!-- factory:post=${event.id}/${post.part} -->`;
      if (!(await this.findOwn(job.repo, post.number, marker))) await this.post(job.repo, post.number, withMarker(post.body, marker));
      entry.done.push(post.part);
      this.outbox.save(name, entry);
    }
    const status = renderStatusComment(job, this.written(job.job_id).pr ?? null);
    const changed = this.written(job.job_id).body !== status;
    await this.ensureLabel(job, changed);
    await this.ensureStatusComment(job, status);
  }

  /**
   * The comment a Job's ending posts: on its PR when cancelled, or on the issue. The Orchestrator
   * makes the ending itself show on GitHub (closing or drafting the PR, the ready label, reopening);
   * the Mirror only says why (ADR 0001).
   */
  private endingPosts({ event, job }: MirrorUpdate): Post[] {
    const pr = this.written(job.job_id).pr?.number;
    const id = job.job_id;
    switch (event.type) {
      case "job-cancelled":
        return pr ? [{ part: "ending", number: pr, body: `${FACTORY_MARKER} Job \`${id}\` was cancelled, so the Factory closes this PR.` }] : [];
      case "job-failed": {
        const why = typeof event.data.reason === "string" ? `: ${cleanAgentText(event.data.reason, 300)}` : "";
        const body = [FACTORY_MARKER, `Job \`${id}\` failed${why}.`, "", `Its draft PR, branches and Working copy are kept for 7 days. To try again, remove and re-apply \`${this.readyLabel()}\`, or run \`factory retry ${id}\`.`, ""];
        return [{ part: "ending", number: job.issue, body: body.join("\n") }];
      }
      case "reverted": {
        const revert = typeof event.data.revert_pr === "number" ? `#${event.data.revert_pr}` : "A revert PR";
        const how = event.data.merged === true ? "reverts it and is merged." : "reverts it and waits for you to merge it.";
        const body = [FACTORY_MARKER, `${String(event.data.why ?? "CI on the default branch went red after the merge.")} ${revert} ${how}`, "", `No new Job starts on its own: apply \`${this.readyLabel()}\` again to try again.`, ""];
        return [{ part: "ending", number: job.issue, body: body.join("\n") }];
      }
      default:
        return [];
    }
  }

  private readyLabel(): string {
    return this.options.readyLabel?.() ?? "factory:ready";
  }

  /** Posts a comment, and learns from GitHub's answer who the Factory comments as. */
  private async post(repo: string, number: number, body: string): Promise<number> {
    const posted = await this.send<Comment>("POST", `/repos/${repo}/issues/${number}/comments`, repo, { body });
    const login = posted.body?.user?.login;
    if (login && this.state.self !== login) {
      this.state.self = login;
      this.saveState();
    }
    return posted.body!.id;
  }

  /**
   * The Factory's own comment carrying `marker`, if there is one. Anyone can paste a marker into a
   * comment, so only one the Factory wrote counts: never take over, or stay quiet because of, someone else's.
   */
  private async findOwn(repo: string, number: number, marker: string): Promise<Comment | undefined> {
    const comments = await this.options.client.all<Comment>(`/repos/${repo}/issues/${number}/comments?per_page=100`, { repo });
    for (const c of comments.filter((c) => c.body?.includes(marker))) if (await this.isOwn(c, repo)) return c;
    return undefined;
  }

  private async isOwn(comment: Comment, repo: string): Promise<boolean> {
    if (!this.state.self && !this.askedWho) {
      this.askedWho = true;
      // A personal token can say whose it is; an App's installation token can't, and is told by its comments instead.
      const me = await this.options.client.request<{ login: string }>("GET", "/user", { repo }).catch(() => null);
      if (me?.status === 200 && me.body?.login) this.state.self = me.body.login;
    }
    if (this.state.self) return comment.user?.login === this.state.self;
    if (!comment.performed_via_github_app || !comment.user?.login) return false;
    this.state.self = comment.user.login;
    return true;
  }

  private dropped(update: MirrorUpdate, why: string): void {
    try {
      this.options.onDropped?.(update, why);
    } catch {
      // Being told is a courtesy; the queue moves on regardless.
    }
  }

  /** One request; a 404 is a refusal like any other (GitHubClient hands it back rather than throwing). */
  private async send<T>(method: string, path: string, repo: string, body?: unknown) {
    const response = await this.options.client.request<T>(method, path, { repo, ...(body !== undefined && { body }) });
    if (response.status === 404) throw new GitHubError(404, `${method} ${path} → 404`);
    return response;
  }

  /**
   * The issue's one status label. Put on again whenever the status comment changes, in case someone
   * took it off; when the status moves, every other status label goes, whoever put it there.
   */
  private async ensureLabel(job: JobState, changed: boolean): Promise<void> {
    const mine = this.written(job.job_id);
    const want = statusLabel(job.status);
    if (mine.label === want && !changed) return;
    const path = `/repos/${job.repo}/issues/${job.issue}/labels`;
    await this.send("POST", path, job.repo, { labels: [want] });
    const stale = mine.label === want ? [] : (await this.options.client.all<{ name: string }>(path, { repo: job.repo })).map((l) => l.name).filter((n) => STATUS_LABELS.has(n));
    for (const name of stale.filter((n) => n !== want)) {
      await this.options.client.request("DELETE", `${path}/${encodeURIComponent(name)}`, { repo: job.repo });
    }
    mine.label = want;
    this.saveState();
  }

  private async ensureStatusComment(job: JobState, body: string): Promise<void> {
    const mine = this.written(job.job_id);
    if (mine.comment && mine.body === body) return;
    // Lost track of it (a crash between posting and saving): find it by its marker rather than post another.
    mine.comment ??= (await this.findOwn(job.repo, job.issue, statusMarker(job.job_id)))?.id;
    if (mine.comment) {
      const edited = await this.options.client.request("PATCH", `/repos/${job.repo}/issues/comments/${mine.comment}`, { repo: job.repo, body: { body } });
      if (edited.status === 404) delete mine.comment;
    }
    mine.comment ??= await this.post(job.repo, job.issue, body);
    mine.body = body;
    this.saveState();
  }

  private written(job_id: string): Written {
    return (this.state.jobs[job_id] ??= {});
  }

  private saveState(): void {
    writeAtomic(this.statePath, JSON.stringify(this.state));
  }
}

/**
 * The comments an event asks for besides the status: the Human request itself, replies to Reply
 * commands sent on GitHub that came too late or while the Job wasn't waiting, the three-day
 * reminder, and the one-line link on a PR the Factory opened. Replies from the CLI get none.
 */
function posts({ event, job }: MirrorUpdate): Post[] {
  const d = event.data;
  switch (event.type) {
    case "human-requested":
      return [{ part: "request", number: job.issue, body: renderHumanRequest(event) }];
    case "human-reminded":
      return [{ part: "reminder", number: job.issue, body: renderReminder(event) }];
    case "pr-opened":
      return typeof d.number === "number" ? [{ part: "pr-link", number: d.number, body: renderPrLink(job) }] : [];
    case "reply-ignored":
      if (d.channel !== "github") return [];
      if (d.why === "already-answered") return [{ part: "reply", number: job.issue, body: renderAlreadyAnswered(event) }];
      if (d.why === "not-waiting") return [{ part: "reply", number: job.issue, body: renderNotWaiting(event) }];
      return [];
    default:
      return [];
  }
}

/** A post with its own marker: on a line of its own, or at the end of a one-line post so it stays one line. */
function withMarker(body: string, marker: string): string {
  return body.endsWith("\n") ? `${body}${marker}\n` : `${body} ${marker}`;
}

/** Records each write the GitHub Mirror drops in the Event log, so what GitHub is missing can be seen. */
export function recordDropped(log: EventLog): NonNullable<GitHubMirrorOptions["onDropped"]> {
  return ({ event }, why) => {
    log.record({ type: "mirror-write-dropped", job_id: event.job_id, attempt: event.attempt, actor: "orchestrator", caused_by: event.id, data: { mirror: "github", event_type: event.type, why } });
  };
}
