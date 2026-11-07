import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentGit, writeIn } from "../helpers/git.js";

/** A Node repo on GitHub (a bare remote) with test, lint and typecheck scripts and an npm lockfile. */
export function nodeRemote(root: string, { failingTest = false } = {}): string {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  agentGit(seed, "init", "-q", "-b", "main");
  writeIn(seed, "package.json", JSON.stringify({ name: "web-app", type: "module", scripts: { test: "node --test", lint: "node -e 0", typecheck: "node -e 0" } }));
  writeIn(seed, "package-lock.json", JSON.stringify({ name: "web-app", lockfileVersion: 3, requires: true, packages: { "": { name: "web-app" } } }));
  writeIn(seed, "test/app.test.js", `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1 + 1, ${failingTest ? 3 : 2}));\n`);
  agentGit(seed, "add", ".");
  agentGit(seed, "commit", "-q", "-m", "Initial commit");
  const remote = join(root, "remote.git");
  agentGit(root, "clone", "-q", "--bare", seed, remote);
  return remote;
}
