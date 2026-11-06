import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Clones } from "../src/repos/clones.js";
import { agentGit, commitAll, makeRemote, writeIn } from "./helpers/git.js";
import { tmpHome } from "./helpers/tmp.js";

function setup() {
  const root = tmpHome();
  const remote = makeRemote(root);
  const home = join(root, "factory-home");
  const clones = new Clones(home, { remoteUrl: () => remote });
  return { root, remote, home, clones };
}

describe("Clones", () => {
  test("an Attempt gets its own Working copy on its branch, cloned from the Trusted clone, with its own HOME and caches", async () => {
    const { home, remote, clones } = setup();
    const wc = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });

    expect(wc.path).toBe(join(home, "work", "job-1", "a1", "repo"));
    expect(readFileSync(join(wc.path, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(agentGit(wc.path, "branch", "--show-current")).toBe("factory/7");
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
    const { remote, clones } = setup();
    const wc = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(wc.path, "src/health.ts", "export const health = 'ok';\n");
    const head = commitAll(wc.path);

    const incoming = await clones.receive(wc);
    expect(incoming.head).toBe(head);
    expect(incoming.refs).toEqual({ "refs/heads/factory/7": head });
    await clones.push(wc, incoming, { remoteHead: null });

    expect(agentGit(remote, "rev-parse", "factory/7")).toBe(head);
  });

  test("hooks and core.fsmonitor planted in a Working copy never run during fetch, checks or push", async () => {
    const { root, clones } = setup();
    const wc = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    const marker = join(root, "PWNED");
    const payload = `#!/bin/sh\necho "$0" >> ${marker}\n`;
    mkdirSync(join(wc.path, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-checkout", "pre-push", "post-merge", "reference-transaction", "pre-auto-gc", "post-index-change"]) {
      writeFileSync(join(wc.path, ".git", "hooks", hook), payload, { mode: 0o755 });
    }
    writeFileSync(join(wc.path, "fsmonitor.sh"), payload, { mode: 0o755 });
    agentGit(wc.path, "config", "core.fsmonitor", join(wc.path, "fsmonitor.sh"));
    agentGit(wc.path, "config", "core.hooksPath", join(wc.path, ".git", "hooks"));
    agentGit(wc.path, "config", "uploadpack.packObjectsHook", join(wc.path, "fsmonitor.sh"));
    agentGit(wc.path, "config", "core.sshCommand", join(wc.path, "fsmonitor.sh"));
    // The agent's own commit may set these off inside its sandbox; that's its business. Clear the marker.
    writeIn(wc.path, "src/health.ts", "export const health = 'ok';\n");
    commitAll(wc.path);
    if (existsSync(marker)) writeFileSync(marker, "");

    const incoming = await clones.receive(wc);
    await clones.push(wc, incoming, { remoteHead: null });
    await clones.checkStageCopy(wc, incoming.head!, "verify-1");

    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  test("a Working copy whose .git is not a real directory is refused", async () => {
    const { clones } = setup();
    const a = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    const b = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-2", attempt: 1, branch: "factory/8" });
    // B points its .git at A's repo, hoping the Orchestrator fetches A's work as B's.
    const { rmSync } = await import("node:fs");
    rmSync(join(b.path, ".git"), { recursive: true });
    writeFileSync(join(b.path, ".git"), `gitdir: ${join(a.path, ".git")}\n`);

    await expect(clones.receive(b)).rejects.toThrow(/\.git is not a directory/);
  });

  test("two Attempts of different Jobs can't see each other's files or branches", async () => {
    const { clones } = setup();
    const a = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(a.path, "src/a-only.ts", "export const a = 'secret-ish';\n");
    writeIn(a.path, "notes.txt", "uncommitted\n");
    agentGit(a.path, "add", "src/a-only.ts");
    agentGit(a.path, "commit", "-q", "-m", "A's work");
    await clones.push(a, await clones.receive(a), { remoteHead: null });

    const b = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-2", attempt: 1, branch: "factory/8" });

    expect(b.path).not.toBe(a.path);
    expect(existsSync(join(b.path, "src/a-only.ts"))).toBe(false);
    expect(existsSync(join(b.path, "notes.txt"))).toBe(false);
    expect(agentGit(b.path, "branch", "-a", "--format=%(refname)").split("\n")).toEqual(["refs/heads/factory/8", "refs/remotes/origin/factory/8"]);
    expect(b.env.HOME).not.toBe(a.env.HOME);
  });

  test("a new Attempt starts from a fresh Working copy; removing a Job deletes all of its Working copies", async () => {
    const { home, clones } = setup();
    const a1 = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    writeIn(a1.path, "scratch.txt", "left over\n");
    const a2 = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 2, branch: "factory/7-a2" });
    expect(existsSync(join(a2.path, "scratch.txt"))).toBe(false);

    await clones.removeJob("job-1");
    expect(existsSync(join(home, "work", "job-1"))).toBe(false);
  });

  test.each([
    ["a commondir file", (git: string, other: string) => writeFileSync(join(git, "commondir"), `${other}\n`)],
    ["swapped alternates", (git: string, other: string) => writeFileSync(join(git, "objects", "info", "alternates"), `${join(other, "objects")}\n`)],
    ["a symlinked objects folder", (git: string, other: string) => {
      rmSync(join(git, "objects"), { recursive: true });
      symlinkSync(join(other, "objects"), join(git, "objects"));
    }],
    ["a symlinked refs folder", (git: string, other: string) => {
      rmSync(join(git, "refs"), { recursive: true });
      symlinkSync(join(other, "refs"), join(git, "refs"));
    }],
  ])("a Working copy whose .git borrows from elsewhere (%s) is refused", async (_what, tamper) => {
    const { clones } = setup();
    const a = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
    const b = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-2", attempt: 1, branch: "factory/8" });
    tamper(join(b.path, ".git"), join(a.path, ".git"));
    await expect(clones.receive(b)).rejects.toThrow(/refusing to fetch/);
  });

  test("two Attempts in the same repo can start and push at the same time", async () => {
    const { remote, clones } = setup();
    const attempts = await Promise.all(
      [1, 2, 3, 4].map((n) => clones.startAttempt({ repo: "acme/web-app", job_id: `job-${n}`, attempt: 1, branch: `factory/${n}` })),
    );
    for (const wc of attempts) {
      writeIn(wc.path, `src/${wc.job_id}.ts`, "x\n");
      commitAll(wc.path);
    }
    await Promise.all(attempts.map(async (wc) => clones.push(wc, await clones.receive(wc), { remoteHead: null })));
    expect(agentGit(remote, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["factory/1", "factory/2", "factory/3", "factory/4", "main"]);
  });
});
