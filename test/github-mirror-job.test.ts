import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { TokenAuth } from "../src/github/auth.js";
import { GitHubClient } from "../src/github/client.js";
import { GitHubMirror } from "../src/mirror/github.js";
import { asks, building, fail, finding, ScriptedAgent } from "./fakes/agent.js";
import { FakeGitHub } from "./fakes/github.js";
import { approved, comment } from "./fakes/source.js";
import { fakeFactory } from "./helpers/factory.js";

const REPO = "acme/web-app";

describe("GitHub Mirror: a whole Job", () => {
  test("a Job with a question, a late reply and a Bounce keeps one status comment, edited in place, and one status label", async () => {
    const f = fakeFactory(
      new ScriptedAgent({
        triage: [asks("REST or GraphQL?", ["REST", "GraphQL"])],
        build: [building, building],
        review: [fail("Missing test.", [finding("missing-test:health", "No test covers /health.")])],
      }),
    );
    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    f.source.push(comment(7, "/answer B"));
    f.source.push(comment(7, "/answer A", { id: "c-late" }));
    await f.orchestrator.runUntilIdle();
    const job = f.onlyJob();

    const github = new FakeGitHub().issue(REPO, 7, { labels: ["factory:ready"] });
    const client = new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch: github.fetch, sleep: async () => {} });
    const mirror = new GitHubMirror({ client, dir: join(f.home, "outbox", "github"), schedule: () => {} });
    // GitHub is down for the first half of the Job, and back for the rest.
    const half = Math.floor(f.mirror.writes.length / 2);
    github.down = true;
    for (const w of f.mirror.writes.slice(0, half)) await mirror.write(w);
    await mirror.drain();
    github.down = false;
    for (const w of f.mirror.writes.slice(half)) {
      await mirror.write(w);
      await mirror.drain();
    }

    const bodies = (github.comments.get(`${REPO}#7`) ?? []).map((c) => c.body);
    const status = bodies.filter((b) => b.includes("factory:status"));
    expect(status).toHaveLength(1);
    expect(status[0]).toContain(`- **Stage:** \`${job.stage}\``);
    expect(status[0]).toContain(`- **Status:** ${job.status}`);
    expect(bodies.filter((b) => b.includes("REST or GraphQL?"))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes("already answered"))).toHaveLength(1);
    expect(github.labelNames(REPO, 7)).toEqual(["factory:ready", `factory:${job.status}`]);
    // Each comment was posted once; every later status change was an edit.
    const posts = github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/comments"));
    expect(posts).toHaveLength(bodies.length);
    expect(github.requests.filter((r) => r.method === "PATCH").length).toBeGreaterThan(0);
  });
});
