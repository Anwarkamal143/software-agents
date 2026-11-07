import { describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli/run.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { fixture } from "./helpers/config.js";
import { STATUS_FIXTURES } from "./fixtures/logs.js";
import { tmpHome } from "./helpers/tmp.js";
import { starterConfig } from "../src/onboarding/config-edit.js";
import { Clones } from "../src/repos/clones.js";
import { FakeGitHub } from "./fakes/github.js";
import { unavailableSandbox } from "./fakes/sandbox.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { makeRemote } from "./helpers/git.js";

async function cli(home: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    home,
    stdout: { write: (s: string) => void (stdout += s) },
    stderr: { write: (s: string) => void (stderr += s) },
  });
  return { code, stdout, stderr };
}

function homeWithJobs() {
  const home = tmpHome();
  const store = openSqliteJobStore(join(home, "factory.db"));
  for (const f of [STATUS_FIXTURES.running, STATUS_FIXTURES.waiting, STATUS_FIXTURES.failed]) {
    for (const event of f.log) store.append(event);
  }
  store.close();
  return home;
}

describe("factory status", () => {
  test("lists Jobs with status, Stage, reason and estimated cost", async () => {
    const { code, stdout } = await cli(homeWithJobs(), "status");
    expect(code).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      "JOB    ISSUE           STATUS   STAGE   REASON           COST (EST.)",
      "job-r  acme/web-app#2  running  build   -                $0.50",
      "job-w  acme/web-app#3  waiting  triage  question         $0.10",
      "job-f  acme/web-app#6  failed   build   retries ran out  $0.00",
    ]);
  });

  test("says when the Factory is paused, and why", async () => {
    const home = homeWithJobs();
    const store = openSqliteJobStore(join(home, "factory.db"));
    store.append({ type: "factory-paused", actor: "orchestrator", data: { reason: "sandbox-unavailable", message: "bubblewrap is not installed" } });
    store.close();

    const { stdout } = await cli(home, "status");

    expect(stdout.split("\n")[0]).toBe("The Factory is paused (sandbox-unavailable): bubblewrap is not installed");
  });

  test("says until when the plan limit parks the Factory", async () => {
    const home = homeWithJobs();
    const store = openSqliteJobStore(join(home, "factory.db"));
    store.append({ type: "plan-limit-hit", actor: "orchestrator", data: { status: "rejected", resets_at: "2026-11-07T18:00:00.000Z" } });
    store.close();

    const { stdout } = await cli(home, "status");

    expect(stdout.split("\n")[0]).toBe("The Factory is paused (plan-limit) until 2026-11-07T18:00:00.000Z.");
  });

  test("warns about a Job queued for over a day, without calling it stuck", async () => {
    const home = tmpHome();
    const store = openSqliteJobStore(join(home, "factory.db"));
    const longAgo = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    store.append({ type: "job-approved", job_id: "job-q", actor: "human:alice", at: longAgo, data: { repo: "acme/web-app", issue: 9 } });
    store.append({ type: "attempt-started", job_id: "job-q", attempt: 1, actor: "orchestrator", at: longAgo, data: { branch: "factory/9" } });
    store.close();

    const { stdout } = await cli(home, "status");

    expect(stdout).toContain("job-q  acme/web-app#9  queued");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("warning: Job job-q has been queued for over a day.");
  });

  test("says so when there are no Jobs yet", async () => {
    const { code, stdout } = await cli(tmpHome(), "status");
    expect(code).toBe(0);
    expect(stdout).toBe("No Jobs yet.\n");
  });
});

describe("factory events", () => {
  test("--json prints the Event log from a given seq, one event per line", async () => {
    const home = homeWithJobs();
    const { code, stdout } = await cli(home, "events", "--json", "--from", "4");
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => [e.seq, e.type, e.job_id])).toEqual([
      [4, "stage-passed", "job-r"],
      [5, "stage-started", "job-r"],
      [6, "job-approved", "job-w"],
      [7, "attempt-started", "job-w"],
      [8, "stage-started", "job-w"],
      [9, "stage-needs-human", "job-w"],
      [10, "human-requested", "job-w"],
      [11, "job-approved", "job-f"],
      [12, "attempt-started", "job-f"],
      [13, "stage-started", "job-f"],
      [14, "stage-errored", "job-f"],
      [15, "job-failed", "job-f"],
    ]);
    expect(Object.keys(lines[0])).toEqual([
      "id", "seq", "type", "schema_version", "at", "job_id", "attempt", "stage_run_id", "actor", "caused_by", "data",
    ]);
  });

  test("without --json prints one readable line per event", async () => {
    const { stdout } = await cli(homeWithJobs(), "events", "--from", "15");
    expect(stdout).toMatch(/^15 \S+ job-failed job-f orchestrator \{"reason":"retries ran out"\}\n$/);
  });
});

describe("factory config check", () => {
  test("passes a good config and shows its warnings", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "factory.yaml"), fixture("draft.yaml"));
    const { code, stdout } = await cli(home, "config", "check");
    expect(code).toBe(0);
    expect(stdout).toBe(
      `${join(home, "factory.yaml")} passes.\n` +
        'warning: Target repo acme/payments-api can\'t run Pipeline "docs": Check Stage "docs-check" needs "docs_verify" commands.\n',
    );
  });

  test("fails when a repo layer sets a Factory-wide value", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "factory.yaml"), fixture("refused/repo-sets-daily-budget.yaml"));
    const { code, stderr } = await cli(home, "config", "check");
    expect(code).toBe(1);
    expect(stderr).toContain("Target repo acme/web-app sets budgets.daily.usd, which only Factory config may set.");
  });

  test("checks another file when given one", async () => {
    const home = tmpHome();
    const other = join(home, "candidate.yaml");
    writeFileSync(other, fixture("minimal.yaml"));
    const { code, stdout } = await cli(home, "config", "check", other);
    expect(code).toBe(0);
    expect(stdout).toBe(`${other} passes.\n`);
  });

  test("reports a missing config file", async () => {
    const home = tmpHome();
    const { code, stderr } = await cli(home, "config", "check");
    expect(code).toBe(1);
    expect(stderr).toBe(`No config at ${join(home, "factory.yaml")}.\n`);
  });
});

test("an unknown command prints usage and exits 2", async () => {
  const { code, stderr } = await cli(tmpHome(), "frobnicate");
  expect(code).toBe(2);
  expect(stderr).toMatch(/^Usage: factory <command>/);
});

describe("factory onboarding commands", () => {
  const run = async (home: string, argv: string[], over: Partial<Parameters<typeof runCli>[1]> = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { home, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: (s: string) => void (stderr += s) }, ...over });
    return { code, stdout, stderr };
  };

  test("secret set reads the value from stdin, never from its arguments", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "factory.yaml"), fixture("minimal.yaml"));
    const secrets = new FakeSecrets();

    const r = await run(home, ["secret", "set", "acme/web-app", "DATABASE_URL"], { secrets, readStdin: async () => "postgres://x\n" });

    expect(r).toMatchObject({ code: 0, stdout: "Stored DATABASE_URL in the keychain. acme/web-app's Check Stages get it as $DATABASE_URL.\n" });
    expect(await secrets.get("DATABASE_URL")).toBe("postgres://x");
    expect((await run(home, ["secret", "set", "acme/web-app"])).code).toBe(2);
  });

  test("doctor exits 1 and names each failing check with its fix", async () => {
    const r = await run(tmpHome(), ["doctor"], { secrets: new FakeSecrets(), doctor: { sandboxes: { agent: unavailableSandbox(), check: unavailableSandbox() } } });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAIL {2}config: No config at .*\n {6}fix: Run `factory init`\.\n/m);
    expect(r.stdout).toMatch(/^FAIL {2}agent-sandbox: bubblewrap is not installed\n {6}fix: /m);
    expect(r.stdout).toMatch(/failed\.\n$/);
  });

  test("repo add with no terminal to confirm in asks for --yes", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "factory.yaml"), starterConfig("alice"));
    const r = await run(home, ["repo", "add", "acme/web-app"], {
      secrets: new FakeSecrets({ GITHUB_TOKEN: "ghp_x" }),
      fetch: new FakeGitHub().fetch,
      clones: new Clones(home, { remoteUrl: () => makeRemote(join(home, "github")) }),
      ask: async () => null,
    });
    expect(r).toMatchObject({ code: 1, stderr: "No terminal to confirm the proposal in: run with --yes to accept it as proposed.\n" });
  });
});
