import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { TokenAuth } from "../src/github/auth.js";
import { GitHubClient } from "../src/github/client.js";
import { starterConfig } from "../src/onboarding/config-edit.js";
import { repoAdd, type Confirmation, type RepoAddDeps } from "../src/onboarding/repo-add.js";
import { SOURCE_CURSOR } from "../src/orchestrator/orchestrator.js";
import { Clones } from "../src/repos/clones.js";
import { SandboxedCheckRunner } from "../src/stages/check-runner.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { FakeGitHub } from "./fakes/github.js";
import { nodeRemote } from "./fixtures/node-repo.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { tmpHome } from "./helpers/tmp.js";

/** Commands that run offline, so the Baseline check here needs no registry. */
const OFFLINE = (proposal: string) => proposal.replace(/- npm ci\n\s+- /g, "- ");

function setup(opts: { failingTest?: boolean; needsSecret?: string; answers?: ((proposal: string) => Confirmation)[]; secretValues?: Record<string, string | null> } = {}) {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), starterConfig("alice"));
  const remote = nodeRemote(join(home, "github"), opts);
  const secrets = new FakeSecrets();
  const asked: string[] = [];
  const gh = new FakeGitHub();
  const proposals: string[] = [];
  const answers = [...(opts.answers ?? [(p: string) => ({ kind: "edited" as const, text: OFFLINE(p) })])];
  let out = "";
  const deps: RepoAddDeps = {
    home,
    clones: new Clones(home, { remoteUrl: () => remote }),
    checks: new SandboxedCheckRunner({ factoryHome: home }),
    github: new GitHubClient({ auth: new TokenAuth("ghp_test"), fetch: gh.fetch }),
    openStore: () => openSqliteJobStore(join(home, "factory.db")),
    confirm: async (proposal: string) => {
      proposals.push(proposal);
      return (answers.shift() ?? answers.at(-1) ?? (() => ({ kind: "no" as const })))(proposal);
    },
    secrets,
    askSecret: async (name: string) => (asked.push(name), opts.secretValues?.[name] ?? null),
    out: (s: string) => void (out += s),
    now: () => new Date("2026-11-07T10:00:00Z"),
  };
  const config = () => readFileSync(join(home, "factory.yaml"), "utf8");
  const cursor = () => (existsSync(join(home, "factory.db")) ? openSqliteJobStore(join(home, "factory.db")).cursor(SOURCE_CURSOR) : null);
  return { home, gh, deps, proposals, config, cursor, secrets, asked, out: () => out };
}

describe("factory repo add", () => {
  test("on a Node repo it proposes test, lint and typecheck Check Stages and registry.npmjs.org, and writes nothing until confirmed", async () => {
    const s = setup({ answers: [() => ({ kind: "no" })] });
    const before = s.config();

    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("declined");

    expect(s.proposals).toHaveLength(1);
    expect(s.proposals[0]).toBe(
      [
        "repo:",
        "  name: acme/web-app",
        "  default_pipeline: acme/web-app",
        "  commands:",
        "    test:",
        "      - npm ci",
        "      - npm test",
        "    lint:",
        "      - npm ci",
        "      - npm run lint",
        "    typecheck:",
        "      - npm ci",
        "      - npm run typecheck",
        "  network:",
        "    - registry.npmjs.org",
        "pipeline:",
        "  stages:",
        "    - triage",
        "    - build",
        "    - test",
        "    - lint",
        "    - typecheck",
        "    - review",
        "    - security",
        "",
      ].join("\n"),
    );
    expect(s.config()).toBe(before);
    expect(s.gh.repoLabels.get("acme/web-app") ?? []).toEqual([]);
    expect(s.cursor()).toBeNull();
  });

  test("once confirmed and the baseline is green, it writes the repo, its Pipeline and Check Stages, labels and first poll", async () => {
    const s = setup();

    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("added");

    const loaded = loadConfig(s.config());
    if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
    expect(loaded.config.repos).toEqual([
      expect.objectContaining({ name: "acme/web-app", default_pipeline: "acme/web-app", commands: { test: ["npm test"], lint: ["npm run lint"], typecheck: ["npm run typecheck"] }, network: ["registry.npmjs.org"] }),
    ]);
    expect(loaded.config.pipelines["acme/web-app"]).toEqual({ stages: ["triage", "build", "test", "lint", "typecheck", "review", "security"] });
    expect(loaded.config.stages.lint).toEqual({ kind: "check", run: "lint", on_fail: "build" });
    // Comments in factory.yaml survive.
    expect(s.config()).toContain("# GitHub logins allowed to approve Jobs");
    expect(s.gh.repoLabels.get("acme/web-app")!.map((l) => l.name)).toEqual([
      "factory:ready", "factory:queued", "factory:running", "factory:waiting", "factory:paused", "factory:merged", "factory:failed", "factory:cancelled",
    ]);
    expect(JSON.parse(s.cursor()!).repos["acme/web-app"]).toMatchObject({ added: "2026-11-07T10:00:00.000Z", since: "2026-11-07T10:00:00.000Z" });
  });

  test("--backfill starts the first poll from the beginning, so issues already labelled ready are picked up", async () => {
    const s = setup();
    await repoAdd("acme/web-app", { backfill: true }, s.deps);
    expect(JSON.parse(s.cursor()!).repos["acme/web-app"]).toMatchObject({ added: "1970-01-01T00:00:00.000Z" });
  });

  test("a repo with a failing test is refused at the Baseline check, and nothing is written", async () => {
    const s = setup({ failingTest: true });
    const before = s.config();

    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("refused");

    expect(s.out()).toMatch(/Refused: the Baseline check failed\. Check Stage "test": `npm test` exited 1\./);
    expect(s.config()).toBe(before);
    expect(s.gh.repoLabels.get("acme/web-app") ?? []).toEqual([]);
    expect(s.cursor()).toBeNull();
  });

  test("--skip-baseline adds it anyway", async () => {
    const s = setup({ failingTest: true });
    expect(await repoAdd("acme/web-app", { skipBaseline: true }, s.deps)).toBe("added");
    expect(loadConfig(s.config())).toMatchObject({ ok: true });
  });

  test("an edit that doesn't pass the config check is shown again with its problems", async () => {
    const s = setup({
      answers: [(p) => ({ kind: "edited", text: OFFLINE(p).replace("  network:\n    - registry.npmjs.org", "  network: registry.npmjs.org") }), () => ({ kind: "no" })],
    });
    const problems: string[][] = [];
    const confirm = s.deps.confirm;
    s.deps.confirm = async (p, why) => (problems.push(why), confirm(p, why));

    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("declined");
    expect(problems[0]).toEqual([]);
    expect(problems[1]!.length).toBeGreaterThan(0);
  });

  test("running it twice doesn't duplicate labels or config", async () => {
    const s = setup();
    await repoAdd("acme/web-app", {}, s.deps);
    const once = s.config();

    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("already-added");

    expect(s.config()).toBe(once);
    expect(s.gh.repoLabels.get("acme/web-app")).toHaveLength(8);
    expect(s.proposals).toHaveLength(1);
  });
});

describe("factory repo add: check secrets", () => {
  const DB = "postgres://app:pw@db/app";

  test("--secret names a check secret: asked for once confirmed, given to the Baseline check, stored only once it passes", async () => {
    const s = setup({ needsSecret: DB, secretValues: { DATABASE_URL: DB } });

    expect(await repoAdd("acme/web-app", { secrets: ["DATABASE_URL"] }, s.deps)).toBe("added");

    expect(s.proposals[0]).toContain("  check_secrets:\n    - DATABASE_URL\n");
    expect(s.asked).toEqual(["DATABASE_URL"]);
    expect(await s.secrets.get("check.acme.web-app.DATABASE_URL")).toBe(DB);
    expect(loadConfig(s.config())).toMatchObject({ ok: true, config: { repos: [{ name: "acme/web-app", check_secrets: ["DATABASE_URL"] }] } });
    expect(s.config()).not.toContain("pw@db");
    expect(s.out()).not.toContain("pw@db");
  });

  test("a check secret named by editing the proposal is asked for too", async () => {
    const s = setup({
      needsSecret: DB,
      secretValues: { DATABASE_URL: DB },
      answers: [(p) => ({ kind: "edited", text: OFFLINE(p).replace("  network:\n", "  check_secrets: [DATABASE_URL]\n  network:\n") })],
    });
    expect(await repoAdd("acme/web-app", {}, s.deps)).toBe("added");
    expect(s.asked).toEqual(["DATABASE_URL"]);
  });

  test("without the secret's value the baseline is red, and a refused repo stores no secret", async () => {
    const s = setup({ needsSecret: DB, secretValues: { DATABASE_URL: "postgres://wrong" } });

    expect(await repoAdd("acme/web-app", { secrets: ["DATABASE_URL"] }, s.deps)).toBe("refused");

    expect(await s.secrets.get("check.acme.web-app.DATABASE_URL")).toBeNull();
    expect(s.gh.repoLabels.get("acme/web-app") ?? []).toEqual([]);
  });

  test("with no way to type a value, it stops before the Baseline check and writes nothing", async () => {
    const s = setup({ needsSecret: DB });
    const before = s.config();
    await expect(repoAdd("acme/web-app", { secrets: ["DATABASE_URL"] }, s.deps)).rejects.toThrow(/DATABASE_URL/);
    expect(s.config()).toBe(before);
    expect(s.gh.repoLabels.get("acme/web-app") ?? []).toEqual([]);
  });

  test("a bad secret name is shown back with the proposal's problems", async () => {
    const problems: string[][] = [];
    const s = setup({ answers: [(p) => ({ kind: "edited", text: OFFLINE(p) }), () => ({ kind: "no" })] });
    const confirm = s.deps.confirm;
    s.deps.confirm = async (p, why) => (problems.push(why), confirm(p, why));
    expect(await repoAdd("acme/web-app", { secrets: ["database-url"] }, s.deps)).toBe("declined");
    expect(problems[1]).toEqual(['repos.0.check_secrets.0 must match pattern "^[A-Za-z_][A-Za-z0-9_]*$".']);
  });
});
