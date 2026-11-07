import { GitHubError, type GitHubClient } from "./client.js";

// What the Orchestrator does with pull requests (ADR 0001): every PR write is its own, never an agent's.

/** How a commit's checks stand on GitHub. */
export type ChecksState = "green" | "pending" | "red" | "none";

export interface PullRequest {
  number: number;
  url: string;
  /** The PR's head commit, as GitHub has it now. */
  head: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  checks: ChecksState;
  /** GitHub can't merge it into its base without conflicts. */
  conflicts: boolean;
}

export interface OpenPullRequest {
  branch: string;
  /** The branch it merges into: the default branch. */
  base: string;
  title: string;
  body: string;
}

export type MergeOutcome =
  | { merged: true; sha: string }
  /** `head-changed`: the PR's head is no longer the commit the gate checked, so GitHub refused (`--match-head-commit`). */
  | { merged: false; why: "head-changed" | "not-mergeable"; message: string };

export interface PullRequests {
  /** The open PR from `branch`, if there is one: so a crash between opening and recording never opens a second. */
  find(repo: string, branch: string): Promise<{ number: number; url: string } | null>;
  /** Opens a draft PR. */
  open(repo: string, pr: OpenPullRequest): Promise<{ number: number; url: string }>;
  get(repo: string, number: number): Promise<PullRequest>;
  markReady(repo: string, number: number): Promise<void>;
  /** Squash-merges the PR only if its head is still `sha`. */
  merge(repo: string, number: number, opts: { sha: string; title: string }): Promise<MergeOutcome>;
  /** How the checks on one commit stand, such as the default branch's first after a merge. */
  commitChecks(repo: string, sha: string): Promise<ChecksState>;
  /** Opens a PR that reverts a merged one. */
  revert(repo: string, number: number, opts: { title: string; body: string }): Promise<{ number: number; url: string }>;
}

interface ApiPull {
  number: number;
  node_id: string;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  /** `dirty`: it conflicts with its base. */
  mergeable_state?: string;
  head: { ref: string; sha: string };
}

/** Check-run conclusions that mean the check didn't pass. */
const RED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/**
 * Pull requests through GitHub's REST API, with GraphQL where REST has no way: marking a draft
 * ready and reverting a merged PR. Every call is the Factory's own, signed for the repo.
 */
export class GitHubPullRequests implements PullRequests {
  constructor(private readonly client: GitHubClient) {}

  async find(repo: string, branch: string) {
    const owner = repo.split("/")[0]!;
    const open = await this.call<ApiPull[]>("GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, repo);
    const pr = open[0];
    return pr ? { number: pr.number, url: pr.html_url } : null;
  }

  async open(repo: string, { branch, base, title, body }: OpenPullRequest) {
    const pr = await this.call<ApiPull>("POST", `/repos/${repo}/pulls`, repo, { head: branch, base, title, body, draft: true });
    return { number: pr.number, url: pr.html_url };
  }

  async get(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.pull(repo, number);
    return {
      number: pr.number,
      url: pr.html_url,
      head: pr.head.sha,
      draft: pr.draft ?? false,
      state: pr.merged ? "merged" : pr.state,
      checks: await this.commitChecks(repo, pr.head.sha),
      conflicts: pr.mergeable_state === "dirty",
    };
  }

  async markReady(repo: string, number: number) {
    const { node_id } = await this.pull(repo, number);
    await this.graphql(repo, "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number}}}", { id: node_id });
  }

  async merge(repo: string, number: number, { sha, title }: { sha: string; title: string }): Promise<MergeOutcome> {
    try {
      const merged = await this.call<{ sha: string }>("PUT", `/repos/${repo}/pulls/${number}/merge`, repo, { sha, merge_method: "squash", commit_title: title });
      return { merged: true, sha: merged.sha };
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (err.status === 409) return { merged: false, why: "head-changed", message: err.message };
      if (err.status === 405 || err.status === 422) return { merged: false, why: "not-mergeable", message: err.message };
      throw err;
    }
  }

  /** Check runs and commit statuses together: any failure is red, anything unfinished pending, nothing at all none. */
  async commitChecks(repo: string, sha: string): Promise<ChecksState> {
    const runs = await this.call<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, repo);
    const status = await this.call<{ state: string; total_count: number }>("GET", `/repos/${repo}/commits/${sha}/status`, repo);
    const statuses = status.total_count > 0;
    if (runs.check_runs.some((r) => r.conclusion !== null && RED_CONCLUSIONS.has(r.conclusion)) || (statuses && (status.state === "failure" || status.state === "error"))) return "red";
    if (runs.check_runs.some((r) => r.status !== "completed") || (statuses && status.state === "pending")) return "pending";
    return runs.check_runs.length || statuses ? "green" : "none";
  }

  async revert(repo: string, number: number, { title, body }: { title: string; body: string }) {
    const { node_id } = await this.pull(repo, number);
    const data = await this.graphql<{ revertPullRequest: { revertPullRequest: { number: number; url: string } } }>(
      repo,
      "mutation($id:ID!,$title:String,$body:String){revertPullRequest(input:{pullRequestId:$id,title:$title,body:$body}){revertPullRequest{number url}}}",
      { id: node_id, title, body },
    );
    return data.revertPullRequest.revertPullRequest;
  }

  private pull(repo: string, number: number): Promise<ApiPull> {
    return this.call<ApiPull>("GET", `/repos/${repo}/pulls/${number}`, repo);
  }

  /** One REST call whose answer is needed: a 404 is an error like any other. */
  private async call<T>(method: string, path: string, repo: string, body?: unknown): Promise<T> {
    const res = await this.client.request<T>(method, path, { repo, ...(body !== undefined && { body }) });
    if (res.status === 404 || res.body === null) throw new GitHubError(res.status, `${method} ${path} → ${res.status}`);
    return res.body;
  }

  private async graphql<T>(repo: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.call<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", repo, { query, variables });
    if (res.errors?.length || !res.data) throw new GitHubError(422, `GraphQL: ${(res.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
    return res.data;
  }
}
