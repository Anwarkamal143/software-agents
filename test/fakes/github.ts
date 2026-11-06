import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Fetch } from "../../src/github/client.js";

/** A recorded response body from test/fixtures/github, as a fresh copy. */
export function recorded<T = Record<string, unknown>>(name: string, over: Record<string, unknown> = {}): T {
  const body = JSON.parse(readFileSync(new URL(`../fixtures/github/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  return { ...body, ...over } as T;
}

type Entry = Record<string, unknown>;
interface FakeIssue {
  issue: Entry;
  timeline: Entry[];
}

let ids = 1;
const user = (login: string) => ({ login, id: login.length, type: "User", site_admin: false });

/**
 * GitHub, replaying recorded responses: issues with their timelines, conditional requests with
 * ETags, a rate limit that 304s don't use, pulls, permissions and the GraphQL editor lookup.
 */
export class FakeGitHub {
  requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  /** The next this-many requests fail with a 502. */
  failNext = 0;
  /** Once this many requests have been made, every later one fails with a 502. */
  failAfter: number | null = null;
  rateLimit = 5000;
  /** Who GraphQL says last edited an issue body. */
  editor: string | null = null;
  permissions = new Map<string, string>([["alice", "write"], ["bob", "admin"]]);
  private readonly issues = new Map<string, FakeIssue>();
  private readonly pulls = new Map<string, string>();

  issue(repo: string, number: number, over: { title?: string; body?: string; labels?: string[]; pr?: { branch: string }; at?: string } = {}): this {
    const at = over.at ?? "2026-11-01T09:00:00Z";
    const issue = recorded("issue", {
      number,
      title: over.title ?? `Issue ${number}`,
      body: over.body ?? "Please do the thing.",
      labels: (over.labels ?? []).map((name) => ({ id: ids++, name, color: "ededed" })),
      created_at: at,
      updated_at: at,
      ...(over.pr && { pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}`, merged_at: null } }),
    });
    this.issues.set(`${repo}#${number}`, { issue, timeline: [] });
    if (over.pr) this.pulls.set(`${repo}#${number}`, over.pr.branch);
    return this;
  }

  /** Something happens on the issue's timeline at `at`, by `by`. */
  happen(repo: string, number: number, event: "labeled" | "unlabeled" | "commented" | "closed" | "reopened" | "merged" | "renamed", at: string, by: string, over: Entry = {}): Entry {
    const it = this.get(repo, number);
    const entry =
      event === "commented"
        ? recorded(`timeline-commented`, { id: ids++, user: user(by), actor: user(by), created_at: at, updated_at: at, ...over })
        : recorded(`timeline-${event}`, { id: ids++, actor: user(by), created_at: at, ...over });
    it.timeline.push(entry);
    it.issue.updated_at = at;
    if (event === "labeled" || event === "unlabeled") {
      const name = (entry.label as { name: string }).name;
      const labels = (it.issue.labels as { name: string }[]).filter((l) => l.name !== name);
      it.issue.labels = event === "labeled" ? [...labels, { id: ids++, name, color: "0e8a16" }] : labels;
    }
    return entry;
  }

  label(repo: string, number: number, at: string, by: string, name = "factory:ready") {
    return this.happen(repo, number, "labeled", at, by, { label: { name, color: "0e8a16" } });
  }

  /** Edits the title or body. A body edit leaves no timeline entry; GraphQL names the editor. */
  edit(repo: string, number: number, at: string, by: string, change: { title?: string; body?: string }) {
    const it = this.get(repo, number);
    if (change.title !== undefined) {
      this.happen(repo, number, "renamed", at, by, { rename: { from: it.issue.title, to: change.title } });
      it.issue.title = change.title;
    }
    if (change.body !== undefined) {
      it.issue.body = change.body;
      this.editor = by;
    }
    it.issue.updated_at = at;
  }

  fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    this.requests.push({ method: init.method, path: u.pathname + u.search, headers: init.headers });
    if (this.failAfter !== null && this.requests.length > this.failAfter) return new Response("bad gateway", { status: 502 });
    if (this.failNext > 0) {
      this.failNext--;
      return new Response("bad gateway", { status: 502 });
    }
    const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => {
      this.rateLimit--;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": String(this.rateLimit), ...headers } });
    };
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
      const repo = m[1]!;
      const since = u.searchParams.get("since") ?? "";
      const list = [...this.issues.entries()]
        .filter(([k, v]) => k.startsWith(`${repo}#`) && String(v.issue.updated_at) >= since)
        .map(([, v]) => v.issue)
        .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
      const etag = `"${createHash("sha1").update(JSON.stringify(list)).digest("hex")}"`;
      // A conditional request that matches: GitHub answers 304 and doesn't count it.
      if (init.headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: { etag, "x-ratelimit-remaining": String(this.rateLimit) } });
      return json(list, { etag });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/timeline$/))) return json(this.get(m[1]!, Number(m[2])).timeline);
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
      const branch = this.pulls.get(`${m[1]}#${m[2]}`)!;
      return json(recorded("pull", { number: Number(m[2]), head: { label: `acme:${branch}`, ref: branch, sha: "6dcb09b5" } }));
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/))) {
      const permission = this.permissions.get(decodeURIComponent(m[2]!));
      return permission ? json(recorded("permission", { permission, role_name: permission })) : json({ message: "Not Found" }, {}, 404);
    }
    if (u.pathname === "/graphql") return json(recorded("graphql-editor", { data: { repository: { issueOrPullRequest: { editor: this.editor ? { login: this.editor } : null } } } }));
    return json({ message: "Not Found" }, {}, 404);
  };

  private get(repo: string, number: number): FakeIssue {
    const it = this.issues.get(`${repo}#${number}`);
    if (!it) throw new Error(`no issue ${repo}#${number}`);
    return it;
  }
}
