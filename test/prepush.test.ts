import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { PrePushChecks } from "../src/repos/prepush.js";
import { Clones, type WorkingCopy } from "../src/repos/clones.js";
import { agentGit, commitAll, makeRemote, writeIn } from "./helpers/git.js";
import { gitleaksPath } from "./helpers/gitleaks.js";
import { tmpHome } from "./helpers/tmp.js";

async function attempt() {
  const root = tmpHome();
  const remote = makeRemote(root);
  const home = join(root, "factory-home");
  const clones = new Clones(home, { remoteUrl: () => remote });
  const wc = await clones.startAttempt({ repo: "acme/web-app", job_id: "job-1", attempt: 1, branch: "factory/7" });
  const checks = new PrePushChecks(home, { gitleaks: gitleaksPath() });
  const check = async (wc: WorkingCopy, profile: "read-only" | "write-branch" = "write-branch", before = wc.base) =>
    checks.run(wc, await clones.receive(wc), { before, profile });
  return { root, remote, clones, wc, check };
}

/** A GitHub token shape gitleaks knows, made fresh so no secret is ever committed to this repo. */
const fakeToken = () => `ghp_${randomBytes(18).toString("hex")}`;

describe("Pre-push checks", () => {
  test("an ordinary change on the Job branch passes", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/health.ts", "export const health = () => 'ok';\n");
    symlinkSync("app.ts", join(wc.path, "src", "main.ts")); // an inward symlink is fine
    commitAll(wc.path);
    expect(await check(wc)).toEqual([]);
  });

  test("an extra branch or tag fails: only the Job branch may move", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/health.ts", "x\n");
    commitAll(wc.path);
    agentGit(wc.path, "branch", "main-hijack");
    agentGit(wc.path, "tag", "v9.9.9");
    expect(await check(wc)).toEqual([
      { check: "only-job-branch", message: "refs/heads/main-hijack isn't the Job branch factory/7." },
      { check: "only-job-branch", message: "refs/tags/v9.9.9 isn't the Job branch factory/7." },
    ]);
  });

  test("rewriting history that was already pushed fails", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "a.txt", "1\n");
    const pushed = commitAll(wc.path);
    agentGit(wc.path, "reset", "-q", "--hard", wc.base);
    writeIn(wc.path, "b.txt", "2\n");
    commitAll(wc.path);
    expect(await check(wc, "write-branch", pushed)).toEqual([
      { check: "only-job-branch", message: `factory/7 no longer contains ${pushed.slice(0, 12)}, which was already pushed.` },
    ]);
  });

  test("a symlink pointing outside the Working copy fails", async () => {
    const { wc, check } = await attempt();
    symlinkSync("/etc/passwd", join(wc.path, "passwd"));
    symlinkSync("../../../../home/.ssh/id_ed25519", join(wc.path, "src", "key"));
    symlinkSync(".git/config", join(wc.path, "gitconfig"));
    commitAll(wc.path);
    expect(await check(wc)).toEqual([
      { check: "outward-symlink", message: "gitconfig points into .git (.git/config)." },
      { check: "outward-symlink", message: "passwd points outside the Working copy (/etc/passwd)." },
      { check: "outward-symlink", message: "src/key points outside the Working copy (../../../../home/.ssh/id_ed25519)." },
    ]);
  });

  test("a submodule change fails", async () => {
    const { wc, remote, check } = await attempt();
    agentGit(wc.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, "vendor/evil");
    commitAll(wc.path);
    expect(await check(wc)).toEqual([
      { check: "submodule", message: ".gitmodules changed." },
      { check: "submodule", message: "vendor/evil is a submodule." },
    ]);
  });

  test("a planted secret fails, even in a commit a later one removes", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/config.ts", `export const token = "${fakeToken()}";\n`);
    commitAll(wc.path, "Add config");
    writeIn(wc.path, "src/config.ts", "export const token = process.env.TOKEN;\n");
    commitAll(wc.path, "Use env");
    const failures = await check(wc);
    expect(failures).toEqual([{ check: "secret-scan", message: "gitleaks found 1 secret (github-pat)." }]);
  });

  test("a gitleaks:allow comment or a planted .gitleaksignore doesn't hide a secret", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/config.ts", `export const token = "${fakeToken()}"; // gitleaks:allow\n`);
    writeIn(wc.path, ".gitleaksignore", "*\n");
    writeIn(wc.path, ".gitleaks.toml", "[allowlist]\npaths = ['''.*''']\n");
    commitAll(wc.path);
    expect((await check(wc)).map((f) => f.check)).toEqual(["secret-scan"]);
  });

  test("commits from a read-only Stage fail: it pushes nothing", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/review-notes.ts", "// I fixed it myself\n");
    const head = commitAll(wc.path);
    expect(await check(wc, "read-only")).toEqual([
      { check: "tool-profile", message: `A read-only Stage committed: factory/7 moved from ${wc.base.slice(0, 12)} to ${head.slice(0, 12)}.` },
    ]);
  });

  test("a deleted Job branch fails", async () => {
    const { wc, check } = await attempt();
    agentGit(wc.path, "checkout", "-q", "-b", "other");
    agentGit(wc.path, "branch", "-q", "-D", "factory/7");
    expect((await check(wc)).map((f) => f.message)).toContain("The Job branch factory/7 is gone.");
  });

  test("a chain of symlinks that each look inward but together escape fails", async () => {
    const { wc, check } = await attempt();
    symlinkSync("..", join(wc.path, "src", "up"));
    symlinkSync("up/..", join(wc.path, "src", "x"));
    commitAll(wc.path);
    expect(await check(wc)).toEqual([{ check: "outward-symlink", message: "src/x points outside the Working copy (up/..)." }]);
  });

  test("a symlink into .git is refused whatever its case", async () => {
    const { wc, check } = await attempt();
    symlinkSync(".GIT/hooks", join(wc.path, "hooks"));
    commitAll(wc.path);
    expect(await check(wc)).toEqual([{ check: "outward-symlink", message: "hooks points into .git (.GIT/hooks)." }]);
  });

  test("a secret in a file git treats as binary is still found", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "assets/blob.dat", `\u0000\u0001binary\ntoken=${fakeToken()}\n`);
    commitAll(wc.path);
    expect((await check(wc)).map((f) => f.check)).toEqual(["secret-scan"]);
  });

  test("a secret in a commit message is found", async () => {
    const { wc, check } = await attempt();
    writeIn(wc.path, "src/a.ts", "x\n");
    agentGit(wc.path, "add", "-A");
    agentGit(wc.path, "commit", "-q", "-m", `Use token ${fakeToken()}`);
    expect((await check(wc)).map((f) => f.check)).toEqual(["secret-scan"]);
  });
});
