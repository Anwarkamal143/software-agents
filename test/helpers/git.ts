import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** git as an agent (or a person) would run it: their own identity, nothing from this machine's config. */
export function agentGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
    },
  }).trim();
}

export function writeIn(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** A bare repo standing in for GitHub, with one commit on `main`. Returns its path. */
export function makeRemote(root: string): string {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  agentGit(seed, "init", "-q", "-b", "main");
  writeIn(seed, "README.md", "# web-app\n");
  writeIn(seed, "src/app.ts", "export const app = 1;\n");
  agentGit(seed, "add", ".");
  agentGit(seed, "commit", "-q", "-m", "Initial commit");
  const remote = join(root, "remote.git");
  agentGit(root, "clone", "-q", "--bare", seed, remote);
  return remote;
}

/** Commits everything in a Working copy, as an agent would. Returns the new head. */
export function commitAll(dir: string, message = "Agent change"): string {
  agentGit(dir, "add", "-A");
  agentGit(dir, "commit", "-q", "-m", message);
  return agentGit(dir, "rev-parse", "HEAD");
}
