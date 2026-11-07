import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, GitHubUnavailable } from "../../src/github/client.js";
import type { ChecksState, MergeOutcome, OpenPullRequest, PullRequest, PullRequests } from "../../src/github/pulls.js";
import { agentGit } from "../helpers/git.js";

interface FakePr extends OpenPullRequest {
  repo: string;
  number: number;
  draft: boolean;
  state: PullRequest["state"];
  /** The commit a merge left on the base branch. */
  mergedAs?: string;
  /** The head it was merged at: GitHub keeps reporting it after the branch is deleted. */
  headAtMerge?: string;
}

/**
 * GitHub's pull requests over the bare repo standing in for it: a PR's head is its branch there,
 * and a merge really squashes onto `main`, so later Jobs have to rebase.
 */
export class FakePullRequests implements PullRequests {
  readonly prs: FakePr[] = [];
  /** Every PR's checks, unless `checksOf` says otherwise. */
  checks: ChecksState = "green";
  /** Checks of particular commits: PR heads, or the default branch after a merge. */
  readonly checksOf = new Map<string, ChecksState>();
  /** GitHub is unreachable: every call throws. */
  down = false;
  /** Runs just before GitHub looks at a merge's head, as someone pushing in between would. */
  beforeMerge: ((pr: FakePr) => void) | null = null;
  readonly calls: string[] = [];
  /** Labels taken off issues, as "<issue> <label>". */
  readonly labelsRemoved: string[] = [];
  /** Issues reopened. */
  readonly reopened: number[] = [];
  /** How each merge was asked for. */
  readonly methods: string[] = [];
  /** GitHub won't merge, whatever the head: branch protection, say. */
  refuseMerges: string | null = null;
  /** GitHub refuses to open PRs. */
  refuseOpens = false;

  constructor(private readonly remote: string) {}

  private call(what: string) {
    if (this.down) throw new GitHubUnavailable("GitHub can't be reached");
    this.calls.push(what);
  }

  async find(repo: string, branch: string) {
    this.call(`find ${branch}`);
    const pr = this.prs.findLast((p) => p.repo === repo && p.branch === branch);
    return pr ? { number: pr.number, url: url(pr.number) } : null;
  }

  async open(repo: string, pr: OpenPullRequest) {
    this.call(`open ${pr.branch}`);
    if (this.refuseOpens) throw new GitHubError(422, "Validation Failed");
    const number = 100 + this.prs.length + 1;
    this.prs.push({ ...pr, repo, number, state: "open" });
    return { number, url: url(number) };
  }

  async get(_repo: string, number: number): Promise<PullRequest> {
    this.call(`get ${number}`);
    const pr = this.pr(number);
    const head = pr.headAtMerge ?? this.head(pr.branch);
    return {
      number,
      url: url(number),
      head,
      draft: pr.draft,
      state: pr.state,
      checks: this.checksOf.get(head) ?? this.checks,
      conflicts: false,
      ...(pr.mergedAs && { mergeCommit: pr.mergedAs }),
    };
  }

  async markReady(_repo: string, number: number) {
    this.call(`ready ${number}`);
    this.pr(number).draft = false;
  }

  async merge(_repo: string, number: number, { sha, title, method }: { sha: string; title: string; method: string }): Promise<MergeOutcome> {
    this.call(`merge ${number}`);
    this.methods.push(method);
    const pr = this.pr(number);
    this.beforeMerge?.(pr);
    if (pr.draft) return { merged: false, why: "not-mergeable", message: "Pull Request is still a draft" };
    if (this.refuseMerges) return { merged: false, why: "not-mergeable", message: this.refuseMerges };
    if (this.head(pr.branch) !== sha) return { merged: false, why: "head-changed", message: "Head branch was modified. Review and try the merge again." };
    const merged = this.inClone((dir) => {
      agentGit(dir, "checkout", "-q", pr.base);
      agentGit(dir, "merge", "-q", "--squash", `origin/${pr.branch}`);
      agentGit(dir, "commit", "-q", "-m", title);
      agentGit(dir, "push", "-q", "origin", pr.base);
      return agentGit(dir, "rev-parse", "HEAD");
    });
    pr.state = "merged";
    pr.mergedAs = merged;
    pr.headAtMerge = sha;
    return { merged: true, sha: merged };
  }

  async commitChecks(_repo: string, sha: string) {
    this.call(`checks ${sha.slice(0, 7)}`);
    return this.checksOf.get(sha) ?? this.checks;
  }

  async close(_repo: string, number: number) {
    this.call(`close ${number}`);
    const pr = this.pr(number);
    if (pr.state === "open") pr.state = "closed";
  }

  async toDraft(_repo: string, number: number) {
    this.call(`draft ${number}`);
    this.pr(number).draft = true;
  }

  async removeLabel(_repo: string, issue: number, label: string) {
    this.call(`unlabel ${issue}`);
    this.labelsRemoved.push(`${issue} ${label}`);
  }

  async reopenIssue(_repo: string, issue: number) {
    this.call(`reopen ${issue}`);
    this.reopened.push(issue);
  }

  /** The PR from `branch`, newest first. */
  of(branch: string): FakePr | undefined {
    return this.prs.findLast((p) => p.branch === branch);
  }

  private pr(number: number): FakePr {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    return pr;
  }

  private head(branch: string): string {
    return agentGit(this.remote, "rev-parse", `refs/heads/${branch}`);
  }

  private inClone<T>(work: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    try {
      agentGit(dir, "clone", "-q", this.remote, ".");
      return work(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const url = (number: number) => `https://github.com/acme/web-app/pull/${number}`;
