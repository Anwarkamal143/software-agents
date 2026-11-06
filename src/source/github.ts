import { createHash } from "node:crypto";
import { GitHubAuthError, GitHubUnavailable, nextLink, type GitHubClient } from "../github/client.js";
import type { IssueText, Source, SourceItem } from "./source.js";

export interface GitHubSourceConfig {
  /** `owner/repo` of every Target repo. */
  repos: string[];
  humans: string[];
  readyLabel: string;
}

export interface GitHubSourceOptions {
  client: GitHubClient;
  /** Read at every poll, so config edits apply at the next one. */
  config: () => GitHubSourceConfig;
  now?: () => Date;
}

/** Where the poll got to in one repo. Saved in the Job store, so a restart carries on from it. */
interface RepoCursor {
  /** When the repo was first polled: timeline entries from before it are never acted on (ADR 0011). */
  added: string;
  /** Issues updated at or after this are asked for. */
  since: string;
  /** The issue list's ETag, for a conditional request. */
  etag?: string;
  /** Per issue: how many timeline entries have been read, and hashes of the title and body last seen. */
  issues: Record<string, { seen: number; title: string; body: string }>;
}

interface Cursor {
  v: 1;
  repos: Record<string, RepoCursor>;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  updated_at: string;
  labels: ({ name: string } | string)[];
  pull_request?: unknown;
}

interface TimelineEntry {
  event: string;
  id?: number;
  created_at?: string;
  actor?: { login: string } | null;
  user?: { login: string } | null;
  label?: { name: string };
  body?: string;
  rename?: { from: string; to: string };
}

/** After GitHub stays down past its transient retries, wait this long, doubling, up to the cap. */
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * The `github-issues` Source (ADR 0006, ADR 0007): one Source for every Target repo. Each poll
 * makes one ETag-conditional "issues updated since" request per repo and reads the timeline of
 * each issue that changed; pull requests arrive the same way. Items come back oldest first, so
 * whatever happened while the Factory was off is caught up in order.
 */
export class GitHubSource implements Source {
  private backoffUntil = 0;
  private backoffMs = BACKOFF_START_MS;

  constructor(private readonly options: GitHubSourceOptions) {}

  async poll(cursorText: string | null): Promise<{ items: SourceItem[]; cursor: string | null }> {
    if (this.now() < this.backoffUntil) return { items: [], cursor: cursorText };
    const cursor = parseCursor(cursorText);
    const config = this.options.config();
    const found: { at: string; order: number; item: SourceItem }[] = [];
    let down = false;
    for (const repo of config.repos) {
      try {
        // Whole or nothing per repo: its cursor moves only once every change is read.
        const next = await this.pollRepo(repo, cursor.repos[repo], config, (at, item) => found.push({ at, order: found.length, item }));
        if (next) cursor.repos[repo] = next;
      } catch (err) {
        if (err instanceof GitHubAuthError) throw err;
        if (!(err instanceof GitHubUnavailable)) throw err;
        down = true;
      }
    }
    if (down) {
      this.backoffUntil = this.now() + this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    } else this.backoffMs = BACKOFF_START_MS;
    found.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
    return { items: found.map((f) => f.item), cursor: JSON.stringify(cursor) };
  }

  async hasWriteAccess(repo: string, login: string): Promise<boolean> {
    const res = await this.options.client.request<{ permission?: string }>("GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { repo });
    return res.status === 200 && ["admin", "maintain", "write"].includes(res.body?.permission ?? "");
  }

  /** The repo's changes since its cursor, or null if nothing changed (a 304). */
  private async pollRepo(repo: string, state: RepoCursor | undefined, config: GitHubSourceConfig, emit: (at: string, item: SourceItem) => void): Promise<RepoCursor | null> {
    const { client } = this.options;
    const now = new Date(this.now()).toISOString();
    const current: RepoCursor = state ?? { added: now, since: now, issues: {} };
    const first = await client.request<Issue[]>("GET", `/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(current.since)}`, {
      repo,
      ...(current.etag && { etag: current.etag }),
    });
    if (first.status === 304) return state ? null : current;
    const issues = [...(first.body ?? [])];
    for (let link = nextLink(first.headers.get("link")); link; ) {
      const page = await client.request<Issue[]>("GET", link, { repo });
      issues.push(...(page.body ?? []));
      link = nextLink(page.headers.get("link"));
    }
    const next: RepoCursor = { ...current, issues: { ...current.issues } };
    const etag = first.headers.get("etag");
    if (etag) next.etag = etag;
    else delete next.etag;
    for (const issue of issues) {
      next.issues[String(issue.number)] = await this.readIssue(repo, issue, current, config, emit);
      if (issue.updated_at > next.since) next.since = issue.updated_at;
    }
    return next;
  }

  private async readIssue(repo: string, issue: Issue, state: RepoCursor, config: GitHubSourceConfig, emit: (at: string, item: SourceItem) => void) {
    const { client } = this.options;
    const seen = state.issues[String(issue.number)];
    const timeline = await client.all<TimelineEntry>(`/repos/${repo}/issues/${issue.number}/timeline?per_page=100`, { repo });
    // An issue never seen before: only what happened since the repo was added counts.
    const fresh = seen ? timeline.slice(seen.seen) : timeline.filter((e) => (e.created_at ?? "") >= state.added);
    const text: IssueText = { number: issue.number, title: issue.title, body: issue.body ?? "" };
    const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
    const allowed = (login: string | undefined): login is string => login !== undefined && config.humans.includes(login);
    const isPr = issue.pull_request !== undefined;
    let branch: string | null = null;
    const prBranch = async () => (branch ??= (await client.request<{ head: { ref: string } }>("GET", `/repos/${repo}/pulls/${issue.number}`, { repo })).body?.head.ref ?? "");
    const merged = fresh.some((e) => e.event === "merged");

    for (const e of fresh) {
      const at = e.created_at ?? issue.updated_at;
      const by = e.actor?.login ?? e.user?.login ?? "";
      if (e.event === "labeled" && e.label?.name === config.readyLabel && allowed(by)) emit(at, { kind: "approved", repo, issue: text, labels, by });
      else if (e.event === "unlabeled" && e.label?.name === config.readyLabel && allowed(by)) emit(at, { kind: "unapproved", repo, issue: issue.number, by });
      else if (e.event === "commented" && e.id !== undefined) {
        emit(at, { kind: "comment", repo, issue: issue.number, comment: { id: String(e.id), body: e.body ?? "", by: e.user?.login ?? by, created_at: at } });
      } else if (e.event === "merged" && isPr) emit(at, { kind: "pr-merged", repo, pr: issue.number, branch: await prBranch(), by });
      else if (e.event === "closed" && isPr && !merged) emit(at, { kind: "pr-closed", repo, pr: issue.number, branch: await prBranch(), by });
      else if (e.event === "closed" && !isPr) emit(at, { kind: "closed", repo, issue: issue.number, by });
      else if (e.event === "reopened" && !isPr) emit(at, { kind: "reopened", repo, issue: issue.number, by });
    }

    const hashes = { title: sha(issue.title), body: sha(issue.body ?? "") };
    if (seen && !isPr && (seen.title !== hashes.title || seen.body !== hashes.body)) {
      const titleBy = seen.title !== hashes.title ? (fresh.findLast((e) => e.event === "renamed")?.actor?.login ?? null) : null;
      const bodyBy = seen.body !== hashes.body ? await this.bodyEditor(repo, issue.number) : null;
      // When two people edited, the one who isn't allowed decides: the edit needs re-approval.
      const editors = [bodyBy, titleBy].filter((l): l is string => l !== null);
      const by = editors.find((l) => !allowed(l)) ?? editors[0] ?? null;
      emit(issue.updated_at, { kind: "edited", repo, issue: text, hash: issueHash(text), by });
    }
    return { seen: timeline.length, ...hashes };
  }

  /** Who last edited the issue body: REST doesn't say, GraphQL does. */
  private async bodyEditor(repo: string, number: number): Promise<string | null> {
    const [owner, name] = repo.split("/");
    const res = await this.options.client.request<{ data?: { repository?: { issueOrPullRequest?: { editor?: { login: string } | null } | null } } }>("POST", "/graphql", {
      repo,
      body: {
        query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{editor{login}}}}}",
        variables: { owner, name, number },
      },
    });
    return res.body?.data?.repository?.issueOrPullRequest?.editor?.login ?? null;
  }

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}

/** The hash an approval is of: the issue's title and body as approved. */
export function issueHash(issue: Pick<IssueText, "title" | "body">): string {
  return sha(`${issue.title}\0${issue.body}`);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function parseCursor(text: string | null): Cursor {
  if (!text) return { v: 1, repos: {} };
  try {
    const parsed = JSON.parse(text) as Cursor;
    return parsed.v === 1 && parsed.repos ? parsed : { v: 1, repos: {} };
  } catch {
    return { v: 1, repos: {} };
  }
}
