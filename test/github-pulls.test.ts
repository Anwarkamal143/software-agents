import { describe, expect, test } from "vitest";
import { TokenAuth } from "../src/github/auth.js";
import { GitHubClient, type Fetch } from "../src/github/client.js";
import { GitHubPullRequests } from "../src/github/pulls.js";

const REPO = "acme/web-app";
const SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

type Route = (body: Record<string, unknown>) => { status?: number; body: unknown };

/** GitHub answering only the routes a test gives, keyed "METHOD /path"; GraphQL by the mutation or query's first word. */
function github(routes: Record<string, Route>) {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    sent.push({ method: init.method, path: u.pathname + u.search, body });
    const key = u.pathname === "/graphql" ? `GRAPHQL ${String(body.query).match(/(?:mutation|query)[^{]*\{\s*(\w+)/)?.[1]}` : `${init.method} ${u.pathname}${u.search}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const answer = route(body);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const pulls = new GitHubPullRequests(new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch, sleep: async () => {} }));
  return { pulls, sent };
}

const pull = (over: Record<string, unknown> = {}) => ({
  number: 12,
  node_id: "PR_node12",
  html_url: `https://github.com/${REPO}/pull/12`,
  state: "open",
  merged: false,
  draft: true,
  mergeable_state: "clean",
  head: { ref: "factory/7", sha: SHA },
  ...over,
});
const runs = (...list: { status: string; conclusion: string | null }[]) => () => ({ body: { total_count: list.length, check_runs: list } });
const status = (state: string, count = 1) => () => ({ body: { state, total_count: count, statuses: Array.from({ length: count }, () => ({ state })) } });
const checks = (r: Route, s: Route) => ({ [`GET /repos/${REPO}/commits/${SHA}/check-runs?per_page=100`]: r, [`GET /repos/${REPO}/commits/${SHA}/status`]: s });

describe("GitHubPullRequests", () => {
  test("opens a draft PR from the Job branch, and finds one already open from it", async () => {
    const { pulls, sent } = github({
      [`POST /repos/${REPO}/pulls`]: () => ({ status: 201, body: pull() }),
      [`GET /repos/${REPO}/pulls?state=open&head=${encodeURIComponent("acme:factory/7")}`]: () => ({ body: [pull()] }),
    });

    expect(await pulls.open(REPO, { branch: "factory/7", base: "main", title: "Add /health", body: "Closes #7." })).toEqual({ number: 12, url: `https://github.com/${REPO}/pull/12` });
    expect(sent[0]!.body).toEqual({ head: "factory/7", base: "main", title: "Add /health", body: "Closes #7.", draft: true });
    expect(await pulls.find(REPO, "factory/7")).toEqual({ number: 12, url: `https://github.com/${REPO}/pull/12` });
  });

  test.each([
    ["every run and status passed", runs({ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }), status("success"), "green"],
    ["a run failed", runs({ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }), status("success"), "red"],
    ["a status errored", runs(), status("error"), "red"],
    ["a run is still going", runs({ status: "in_progress", conclusion: null }), status("success"), "pending"],
    ["a status is pending", runs({ status: "completed", conclusion: "success" }), status("pending"), "pending"],
    ["nothing ran", runs(), status("pending", 0), "none"],
  ] as const)("checks are %s → %s", async (_why, r, s, want) => {
    const { pulls } = github(checks(r, s));
    expect(await pulls.commitChecks(REPO, SHA)).toBe(want);
  });

  test("get reads the head, draft, state, checks and conflicts", async () => {
    const { pulls } = github({
      [`GET /repos/${REPO}/pulls/12`]: () => ({ body: pull({ mergeable_state: "dirty" }) }),
      ...checks(runs({ status: "completed", conclusion: "success" }), status("success")),
    });
    expect(await pulls.get(REPO, 12)).toEqual({ number: 12, url: `https://github.com/${REPO}/pull/12`, head: SHA, draft: true, state: "open", checks: "green", conflicts: true });
  });

  test("merge squashes only at the given head; a 409 is GitHub refusing a changed head", async () => {
    let answer: { status?: number; body: unknown } = { body: { sha: "merged1", merged: true } };
    const { pulls, sent } = github({ [`PUT /repos/${REPO}/pulls/12/merge`]: () => answer });

    expect(await pulls.merge(REPO, 12, { sha: SHA, title: "Add /health (#12)" })).toEqual({ merged: true, sha: "merged1" });
    expect(sent[0]!.body).toEqual({ sha: SHA, merge_method: "squash", commit_title: "Add /health (#12)" });

    answer = { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
    expect(await pulls.merge(REPO, 12, { sha: SHA, title: "t" })).toMatchObject({ merged: false, why: "head-changed" });
    answer = { status: 405, body: { message: "Pull Request is not mergeable" } };
    expect(await pulls.merge(REPO, 12, { sha: SHA, title: "t" })).toMatchObject({ merged: false, why: "not-mergeable", message: expect.stringContaining("not mergeable") });
  });

  test("marking ready and reverting go through GraphQL by the PR's node id", async () => {
    const { pulls, sent } = github({
      [`GET /repos/${REPO}/pulls/12`]: () => ({ body: pull() }),
      "GRAPHQL markPullRequestReadyForReview": () => ({ body: { data: { markPullRequestReadyForReview: { pullRequest: { number: 12 } } } } }),
      "GRAPHQL revertPullRequest": () => ({ body: { data: { revertPullRequest: { revertPullRequest: { number: 13, url: `https://github.com/${REPO}/pull/13` } } } } }),
    });

    await pulls.markReady(REPO, 12);
    expect(await pulls.revert(REPO, 12, { title: "Revert #12", body: "CI went red." })).toEqual({ number: 13, url: `https://github.com/${REPO}/pull/13` });
    const graphql = sent.filter((r) => r.path === "/graphql").map((r) => r.body.variables);
    expect(graphql).toEqual([{ id: "PR_node12" }, { id: "PR_node12", title: "Revert #12", body: "CI went red." }]);
  });

  test("a GraphQL error is an error, not a quiet success", async () => {
    const { pulls } = github({
      [`GET /repos/${REPO}/pulls/12`]: () => ({ body: pull() }),
      "GRAPHQL markPullRequestReadyForReview": () => ({ body: { errors: [{ message: "Resource not accessible by integration" }] } }),
    });
    await expect(pulls.markReady(REPO, 12)).rejects.toThrow("Resource not accessible by integration");
  });
});
