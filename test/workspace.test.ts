import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoWorkspace } from "../src/repos/workspace.js";
import { agentGit, commitAll, makeRemote, writeIn } from "./helpers/git.js";
import { tmpHome } from "./helpers/tmp.js";

function setup() {
  const root = tmpHome();
  const remote = makeRemote(root);
  const home = join(root, "factory-home");
  const workspace = new RepoWorkspace(home, { remoteUrl: () => remote });
  return { root, remote, home, workspace };
}

describe("RepoWorkspace", () => {
  test("an Attempt gets its own Working copy on its branch, cloned from the Trusted clone, with its own HOME and caches", async () => {
    const { home, remote, workspace } = setup();
    const wc = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });

    expect(wc.repo).toBe(join(home, "work", "job-1", "a1", "repo"));
    expect(readFileSync(join(wc.repo, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(agentGit(wc.repo, "branch", "--show-current")).toBe("factory/7");
    expect(wc.base).toBe(agentGit(remote, "rev-parse", "main"));
    expect(wc.env).toEqual({
      HOME: join(home, "work", "job-1", "a1", "home"),
      XDG_CONFIG_HOME: join(home, "work", "job-1", "a1", "home", ".config"),
      XDG_CACHE_HOME: join(home, "work", "job-1", "a1", "cache"),
      npm_config_cache: join(home, "work", "job-1", "a1", "cache", "npm"),
      TMPDIR: join(home, "work", "job-1", "a1", "tmp"),
    });
    for (const dir of Object.values(wc.env)) expect(existsSync(dir)).toBe(true);
    // The Trusted clone lives in the Factory home, shared by every Attempt of this repo.
    expect(existsSync(join(home, "repos", "acme", "web-app.git", "HEAD"))).toBe(true);
  });

  test("an agent's commits come back through the Trusted clone and are pushed to the remote", async () => {
    const { remote, workspace } = setup();
    const wc = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(wc.repo, "src/health.ts", "export const health = 'ok';\n");
    const head = commitAll(wc.repo);

    const incoming = await workspace.receive(wc);
    expect(incoming.head).toBe(head);
    expect(incoming.refs).toEqual({ "refs/heads/factory/7": head });
    await workspace.push(wc, incoming, { remoteHead: null });

    expect(agentGit(remote, "rev-parse", "factory/7")).toBe(head);
  });

  test("hooks and core.fsmonitor planted in a Working copy never run during fetch, checks or push", async () => {
    const { root, workspace } = setup();
    const wc = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    const marker = join(root, "PWNED");
    const payload = `#!/bin/sh\necho "$0" >> ${marker}\n`;
    mkdirSync(join(wc.repo, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-checkout", "pre-push", "post-merge", "reference-transaction", "pre-auto-gc", "post-index-change"]) {
      writeFileSync(join(wc.repo, ".git", "hooks", hook), payload, { mode: 0o755 });
    }
    writeFileSync(join(wc.repo, "fsmonitor.sh"), payload, { mode: 0o755 });
    agentGit(wc.repo, "config", "core.fsmonitor", join(wc.repo, "fsmonitor.sh"));
    agentGit(wc.repo, "config", "core.hooksPath", join(wc.repo, ".git", "hooks"));
    agentGit(wc.repo, "config", "uploadpack.packObjectsHook", join(wc.repo, "fsmonitor.sh"));
    agentGit(wc.repo, "config", "core.sshCommand", join(wc.repo, "fsmonitor.sh"));
    // The agent's own commit may set these off inside its sandbox; that's its business. Clear the marker.
    writeIn(wc.repo, "src/health.ts", "export const health = 'ok';\n");
    commitAll(wc.repo);
    if (existsSync(marker)) writeFileSync(marker, "");

    const incoming = await workspace.receive(wc);
    await workspace.push(wc, incoming, { remoteHead: null });
    await workspace.checkout(wc, incoming.head!, "verify-1");

    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  test("a Working copy whose .git is not a real directory is refused", async () => {
    const { workspace } = setup();
    const a = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    const b = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-2", attempt: 1, branch: "factory/8" });
    // B points its .git at A's repo, hoping the Orchestrator fetches A's work as B's.
    const { rmSync } = await import("node:fs");
    rmSync(join(b.repo, ".git"), { recursive: true });
    writeFileSync(join(b.repo, ".git"), `gitdir: ${join(a.repo, ".git")}\n`);

    await expect(workspace.receive(b)).rejects.toThrow(/\.git is not a directory/);
  });

  test("two Attempts of different Jobs can't see each other's files or branches", async () => {
    const { workspace } = setup();
    const a = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(a.repo, "src/a-only.ts", "export const a = 'secret-ish';\n");
    writeIn(a.repo, "notes.txt", "uncommitted\n");
    agentGit(a.repo, "add", "src/a-only.ts");
    agentGit(a.repo, "commit", "-q", "-m", "A's work");
    await workspace.push(a, await workspace.receive(a), { remoteHead: null });

    const b = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-2", attempt: 1, branch: "factory/8" });

    expect(b.repo).not.toBe(a.repo);
    expect(existsSync(join(b.repo, "src/a-only.ts"))).toBe(false);
    expect(existsSync(join(b.repo, "notes.txt"))).toBe(false);
    expect(agentGit(b.repo, "branch", "-a", "--format=%(refname)").split("\n")).toEqual(["refs/heads/factory/8", "refs/remotes/origin/factory/8"]);
    expect(b.env.HOME).not.toBe(a.env.HOME);
  });

  test("a new Attempt starts from a fresh Working copy; removing a Job deletes all of its Working copies", async () => {
    const { home, workspace } = setup();
    const a1 = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(a1.repo, "scratch.txt", "left over\n");
    const a2 = await workspace.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 2, branch: "factory/7-a2" });
    expect(existsSync(join(a2.repo, "scratch.txt"))).toBe(false);

    await workspace.removeJob("job-1");
    expect(existsSync(join(home, "work", "job-1"))).toBe(false);
  });
});
