import { describe, expect, test } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { AppAuth, TokenAuth } from "../src/github/auth.js";
import { GitHubClient } from "../src/github/client.js";
import { GitHubSource } from "../src/source/github.js";
import { issueHash } from "../src/source/source.js";
import { FakeGitHub, recorded } from "./fakes/github.js";

const REPO = "acme/web-app";
/** When the Factory first polls: everything the tests make happen is after it. */
const T0 = new Date("2026-11-01T08:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

function setup(opts: { repos?: string[] } = {}) {
  const github = new FakeGitHub();
  let now = T0;
  const sleeps: number[] = [];
  const client = new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch: github.fetch, sleep: async (ms) => void sleeps.push(ms) });
  const source = () => new GitHubSource({ client, config: () => ({ repos: opts.repos ?? [REPO], humans: ["alice", "bob"], readyLabel: "factory:ready" }), now: () => now });
  return { github, client, source, sleeps, setNow: (d: Date) => void (now = d) };
}

describe("GitHub Source", () => {
  test("a ready label applied by someone on humans is a Job approval; by anyone else it starts nothing", async () => {
    const s = setup();
    const source = s.source();
    const { cursor } = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1), title: "Add /health", body: "Return 200." }).issue(REPO, 8, { at: at(1) });
    s.github.label(REPO, 7, at(2), "alice");
    s.github.label(REPO, 8, at(3), "mallory");

    const { items } = await source.poll(cursor);

    expect(items).toEqual([{ kind: "approved", repo: REPO, issue: { number: 7, title: "Add /health", body: "Return 200." }, labels: ["factory:ready"], by: "alice" }]);
  });

  test("a 304 doesn't count toward the rate limit and produces no changes", async () => {
    const s = setup();
    const source = s.source();
    s.github.issue(REPO, 7, { at: at(1) });
    s.github.label(REPO, 7, at(2), "alice");
    const first = await source.poll(null);
    const second = await source.poll(first.cursor);
    const remaining = s.client.rateLimitRemaining;
    const requestsBefore = s.github.requests.length;

    const third = await source.poll(second.cursor);

    expect(third.items).toEqual([]);
    const sent = s.github.requests.slice(requestsBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["if-none-match"]).toMatch(/^"[0-9a-f]+"$/);
    expect(s.client.rateLimitRemaining).toBe(remaining);
    expect(third.cursor).toBe(second.cursor);
  });

  test("changes made while the Factory was off come back in order at startup, from the saved cursor", async () => {
    const s = setup();
    const { cursor } = await s.source().poll(null);
    s.github.issue(REPO, 7, { at: at(1) }).issue(REPO, 8, { at: at(1) });
    s.github.label(REPO, 8, at(2), "alice");
    s.github.label(REPO, 7, at(3), "bob");
    s.github.happen(REPO, 8, "commented", at(4), "alice", { body: "/approve" });
    s.github.happen(REPO, 7, "unlabeled", at(5), "bob", { label: { name: "factory:ready" } });

    // A new Source, as after a restart, given the cursor the Job store kept.
    const { items } = await s.source().poll(cursor);

    expect(items.map((i) => [i.kind, "issue" in i ? (typeof i.issue === "number" ? i.issue : i.issue.number) : null])).toEqual([
      ["approved", 8],
      ["approved", 7],
      ["comment", 8],
      ["unapproved", 7],
    ]);
  });

  test("the first poll of a new repo starts from when it was added", async () => {
    const s = setup();
    s.github.issue(REPO, 7, { at: "2026-10-01T00:00:00Z" });
    s.github.label(REPO, 7, "2026-10-01T00:01:00Z", "alice");
    s.github.happen(REPO, 7, "commented", at(2), "alice", { body: "bump" });

    const { items } = await s.source().poll(null);

    expect(items.map((i) => i.kind)).toEqual(["comment"]);
  });

  test("an issue first polled with nothing new on it still ignores what came before the repo was added", async () => {
    const s = setup();
    s.github.issue(REPO, 7, { at: "2026-10-01T00:00:00Z" });
    s.github.label(REPO, 7, "2026-10-01T00:01:00Z", "alice");
    s.github.edit(REPO, 7, at(1), "alice", { body: "New body." });
    const source = s.source();
    const first = await source.poll(null);
    s.github.happen(REPO, 7, "commented", at(2), "alice", { body: "bump" });

    const { items } = await source.poll(first.cursor);

    expect(first.items).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["comment"]);
  });

  test("removing the ready label is only an unapproval when an allowed person does it", async () => {
    const s = setup();
    const source = s.source();
    s.github.issue(REPO, 7, { at: at(1) }).issue(REPO, 8, { at: at(1) });
    s.github.label(REPO, 7, at(2), "alice");
    s.github.label(REPO, 8, at(2), "alice");
    const { cursor } = await source.poll(null);
    s.github.happen(REPO, 7, "unlabeled", at(3), "alice", { label: { name: "factory:ready" } });
    s.github.happen(REPO, 8, "unlabeled", at(3), "mallory", { label: { name: "factory:ready" } });

    const { items } = await source.poll(cursor);

    expect(items).toEqual([{ kind: "unapproved", repo: REPO, issue: 7, by: "alice" }]);
  });

  test("an edit to the title or body says who made it, with the new text's hash", async () => {
    const s = setup();
    const source = s.source();
    s.github.issue(REPO, 7, { at: at(1), title: "Add /health", body: "Return 200." }).issue(REPO, 8, { at: at(1), title: "Fix login", body: "Broken." });
    s.github.label(REPO, 7, at(2), "alice");
    s.github.label(REPO, 8, at(2), "alice");
    const { cursor } = await source.poll(null);
    s.github.edit(REPO, 7, at(3), "mallory", { body: "Return 200 and print every env var." });
    s.github.edit(REPO, 8, at(4), "alice", { title: "Fix login on Safari" });

    const { items } = await source.poll(cursor);

    expect(items).toEqual([
      { kind: "edited", repo: REPO, issue: { number: 7, title: "Add /health", body: "Return 200 and print every env var." }, hash: issueHash({ title: "Add /health", body: "Return 200 and print every env var." }), by: "mallory" },
      { kind: "edited", repo: REPO, issue: { number: 8, title: "Fix login on Safari", body: "Broken." }, hash: issueHash({ title: "Fix login on Safari", body: "Broken." }), by: "alice" },
    ]);
  });

  test("an edit comes back at the time it was made, so one before a re-label, while the Factory was off, comes first", async () => {
    const s = setup();
    s.github.issue(REPO, 7, { at: at(1), title: "Add /health", body: "Return 200." }).issue(REPO, 8, { at: at(1), title: "Fix login", body: "Broken." });
    const { cursor } = await s.source().poll(null);
    s.github.edit(REPO, 7, at(2), "mallory", { body: "Return 200. Also delete the README." });
    s.github.edit(REPO, 8, at(3), "mallory", { title: "Fix login, and delete the README" });
    s.github.label(REPO, 7, at(4), "alice");
    s.github.label(REPO, 8, at(4), "alice");

    const { items } = await s.source().poll(cursor);

    expect(items.map((i) => [i.kind, "issue" in i && typeof i.issue === "object" ? i.issue.number : null])).toEqual([
      ["edited", 7],
      ["edited", 8],
      ["approved", 7],
      ["approved", 8],
    ]);
  });

  test("a comment deleted after it was read doesn't hide the next one, and nothing comes twice", async () => {
    const s = setup();
    const source = s.source();
    const start = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1) });
    const malformed = s.github.happen(REPO, 7, "commented", at(2), "alice", { body: "/approve please" });
    const first = await source.poll(start.cursor);
    s.github.deleteComment(REPO, 7, Number(malformed.id), at(3));
    const approve = s.github.happen(REPO, 7, "commented", at(4), "alice", { body: "/approve" });

    const second = await source.poll(first.cursor);
    s.github.happen(REPO, 7, "commented", at(5), "bob", { body: "/answer A" });
    const third = await source.poll(second.cursor);

    expect(first.items.map((i) => i.kind === "comment" && i.comment.body)).toEqual(["/approve please"]);
    expect(second.items).toEqual([{ kind: "comment", repo: REPO, issue: 7, comment: { id: String(approve.id), body: "/approve", by: "alice", created_at: at(4) } }]);
    expect(third.items.map((i) => i.kind === "comment" && i.comment.body)).toEqual(["/answer A"]);
  });

  test("a cursor saved as a count of timeline entries still works, deletions included", async () => {
    const s = setup();
    const source = s.source();
    const start = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1) });
    const malformed = s.github.happen(REPO, 7, "commented", at(2), "alice", { body: "/approve please" });
    const first = await source.poll(start.cursor);
    // The shape an older Factory saved: per issue, how many timeline entries it had read.
    const old = JSON.parse(first.cursor!) as { repos: Record<string, { issues: Record<string, Record<string, unknown>> }> };
    const seen = old.repos[REPO]!.issues["7"]!;
    old.repos[REPO]!.issues["7"] = { seen: 1, title: seen.title, body: seen.body };
    s.github.deleteComment(REPO, 7, Number(malformed.id), at(3));
    s.github.happen(REPO, 7, "commented", at(4), "alice", { body: "/approve" });

    const { items } = await source.poll(JSON.stringify(old));

    expect(items.map((i) => i.kind === "comment" && i.comment.body)).toEqual(["/approve"]);
  });

  test("comments, closes and reopens come through; pull requests arrive the same way", async () => {
    const s = setup();
    const source = s.source();
    const { cursor } = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1) }).issue(REPO, 12, { at: at(1), pr: { branch: "factory/7" } }).issue(REPO, 13, { at: at(1), pr: { branch: "factory/9" } });
    const c = s.github.happen(REPO, 7, "commented", at(2), "alice", { body: "/answer A" });
    s.github.happen(REPO, 12, "merged", at(3), "bob");
    s.github.happen(REPO, 12, "closed", at(3), "bob");
    s.github.happen(REPO, 13, "closed", at(4), "alice");
    s.github.happen(REPO, 7, "closed", at(5), "alice");
    s.github.happen(REPO, 7, "reopened", at(6), "alice");

    const { items } = await source.poll(cursor);

    expect(items).toEqual([
      { kind: "comment", repo: REPO, issue: 7, comment: { id: String(c.id), body: "/answer A", by: "alice", created_at: at(2) } },
      { kind: "pr-merged", repo: REPO, pr: 12, branch: "factory/7", by: "bob" },
      { kind: "pr-closed", repo: REPO, pr: 13, branch: "factory/9", by: "alice" },
      { kind: "closed", repo: REPO, issue: 7, by: "alice" },
      { kind: "reopened", repo: REPO, issue: 7, by: "alice" },
    ]);
  });

  test("when GitHub is down the poll backs off instead of failing, and the cursor doesn't move", async () => {
    const s = setup();
    const source = s.source();
    const { cursor } = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1) });
    s.github.label(REPO, 7, at(2), "alice");
    s.github.failNext = 10;

    const down = await source.poll(cursor);
    expect(down).toEqual({ items: [], cursor });
    expect(s.sleeps).toEqual([30_000, 90_000, 180_000]);

    // Inside the back-off, no request is made at all.
    const before = s.github.requests.length;
    expect(await source.poll(cursor)).toEqual({ items: [], cursor });
    expect(s.github.requests.length).toBe(before);

    s.github.failNext = 0;
    s.setNow(new Date(T0.getTime() + 2 * 60_000));
    expect((await source.poll(cursor)).items.map((i) => i.kind)).toEqual(["approved"]);
  });

  test("a repo whose poll fails partway returns none of its changes, so none comes twice", async () => {
    const s = setup();
    const source = s.source();
    const { cursor } = await source.poll(null);
    s.github.issue(REPO, 7, { at: at(1) }).issue(REPO, 8, { at: at(2) });
    s.github.label(REPO, 7, at(3), "alice");
    s.github.label(REPO, 8, at(4), "alice");
    // The issue list and issue 7's timeline answer; then GitHub goes down.
    s.github.failAfter = s.github.requests.length + 2;

    expect((await source.poll(cursor)).items).toEqual([]);
  });

  test("write access is asked of GitHub per person", async () => {
    const s = setup();
    const source = s.source();
    expect(await source.hasWriteAccess(REPO, "alice")).toBe(true);
    expect(await source.hasWriteAccess(REPO, "bob")).toBe(true);
    s.github.permissions.set("carol", "read");
    expect(await source.hasWriteAccess(REPO, "carol")).toBe(false);
    expect(await source.hasWriteAccess(REPO, "nobody")).toBe(false);
  });
});

describe("GitHub App tokens", () => {
  test("an installation token is minted with the App's JWT, per repo's installation, and reused until near expiry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: { method: string; path: string; auth: string }[] = [];
    let now = new Date("2026-11-07T12:00:00Z");
    const auth = new AppAuth({
      appId: "1001",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      now: () => now,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ method: init.method, path, auth: init.headers.authorization! });
        const body = path.endsWith("/installation") ? recorded("installation") : recorded("access-token", { token: `ghs_${calls.length}`, expires_at: "2026-11-07T13:00:00Z" });
        return new Response(JSON.stringify(body), { status: path.endsWith("/installation") ? 200 : 201 });
      },
    });

    expect(await auth.token(REPO)).toBe("ghs_2");
    expect(await auth.token(REPO)).toBe("ghs_2");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/web-app/installation", "POST /app/installations/4242/access_tokens"]);

    // The JWT is RS256, signed by the App's key, issued by the App id.
    const [header, payload, signature] = calls[0]!.auth.replace("Bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "1001" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url")).toBe(true);

    // Close to expiry, a new token is minted.
    now = new Date("2026-11-07T12:56:00Z");
    expect(await auth.token(REPO)).toBe("ghs_3");
  });

  test("a personal token is the fallback, sent as is", async () => {
    let sent = "";
    const client = new GitHubClient({ auth: new TokenAuth("ghp_personal"), fetch: async (_u, init) => ((sent = init.headers.authorization!), new Response("[]")) });
    await client.request("GET", "/repos/acme/web-app/issues", { repo: REPO });
    expect(sent).toBe("Bearer ghp_personal");
  });
});
