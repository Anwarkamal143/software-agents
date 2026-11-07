import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { githubAuthFromKeychain } from "../github/auth.js";
import { GitHubClient, type Fetch } from "../github/client.js";
import { homePaths } from "../home.js";
import { renderSelfChecks, selfChecks, type DoctorDeps } from "../onboarding/doctor.js";
import { factoryInit } from "../onboarding/init.js";
import { manifestFlow } from "../onboarding/manifest.js";
import { repoAdd, type Confirmation } from "../onboarding/repo-add.js";
import { secretSet } from "../onboarding/secret-set.js";
import { Clones } from "../repos/clones.js";
import { OsKeychain, type WritableSecretStore } from "../secrets/keychain.js";
import { SandboxedCheckRunner, srtSandbox, type CheckRunner } from "../stages/check-runner.js";
import { openSqliteJobStore } from "../store/sqlite-job-store.js";

/** What onboarding commands read and the machine they run on. Tests replace parts of it. */
export interface OnboardingIo {
  home: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  /** All of stdin, for a secret or a token: never an argument, so never in shell history. */
  readStdin?: () => Promise<string>;
  /** One line of answer from you; null when there's no terminal to ask. */
  ask?: (question: string) => Promise<string | null>;
  secrets?: WritableSecretStore;
  fetch?: Fetch;
  checks?: CheckRunner;
  clones?: Clones;
  doctor?: Partial<DoctorDeps>;
}

export async function initCommand(args: string[], io: OnboardingIo): Promise<number> {
  const { values } = parseArgs({ args, options: { token: { type: "boolean", default: false }, org: { type: "string" } } });
  await factoryInit(
    { token: values.token },
    {
      home: io.home,
      secrets: io.secrets ?? new OsKeychain(),
      out: (s) => io.stdout.write(s),
      readToken: io.readStdin ?? readStdin,
      manifestFlow: () => manifestFlow({ open: openBrowser, out: (s) => io.stdout.write(s), ...(values.org && { org: values.org }) }),
      ...(io.fetch && { fetch: io.fetch }),
    },
  );
  return 0;
}

export async function repoCommand(args: string[], io: OnboardingIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "add") {
    io.stderr.write("Usage: factory repo add <owner/repo> [--yes] [--skip-baseline] [--backfill]\n");
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { yes: { type: "boolean", short: "y", default: false }, "skip-baseline": { type: "boolean", default: false }, backfill: { type: "boolean", default: false } },
  });
  const [name] = positionals;
  if (!name) {
    io.stderr.write("Usage: factory repo add <owner/repo> [--yes] [--skip-baseline] [--backfill]\n");
    return 2;
  }
  const secrets = io.secrets ?? new OsKeychain();
  const outcome = await repoAdd(
    name,
    { skipBaseline: values["skip-baseline"], backfill: values.backfill },
    {
      home: io.home,
      clones: io.clones ?? new Clones(io.home, { remoteUrl: (repo) => `https://github.com/${repo}.git` }),
      checks: io.checks ?? new SandboxedCheckRunner({ factoryHome: io.home }),
      github: new GitHubClient({ auth: await githubAuthFromKeychain(secrets, io.fetch), ...(io.fetch && { fetch: io.fetch }) }),
      openStore: () => openSqliteJobStore(homePaths(io.home).jobStore),
      confirm: (proposal, problems) => (values.yes && !problems.length ? Promise.resolve({ kind: "yes" }) : confirmInTerminal(proposal, problems, io)),
      out: (s) => io.stdout.write(s),
    },
  ).finally(() => srtSandbox.close());
  return outcome === "added" || outcome === "already-added" ? 0 : 1;
}

export async function secretCommand(args: string[], io: OnboardingIo): Promise<number> {
  const [sub, repo, name] = args;
  if (sub !== "set" || !repo || !name) {
    io.stderr.write("Usage: factory secret set <owner/repo> <NAME>   (the value is read from stdin)\n");
    return 2;
  }
  await secretSet(repo, name, io.readStdin ?? readStdin, { home: io.home, secrets: io.secrets ?? new OsKeychain(), out: (s) => io.stdout.write(s) });
  return 0;
}

export async function doctorCommand(args: string[], io: OnboardingIo): Promise<number> {
  const { values } = parseArgs({ args, options: { baseline: { type: "boolean", default: false } } });
  const sandboxes = { agent: srtSandbox, check: srtSandbox, ...io.doctor?.sandboxes };
  const checks = await selfChecks(
    {
      home: io.home,
      secrets: io.secrets ?? new OsKeychain(),
      sandboxes,
      ...(io.fetch && { fetch: io.fetch }),
      baseline: { clones: io.clones ?? new Clones(io.home, { remoteUrl: (repo) => `https://github.com/${repo}.git` }), checks: io.checks ?? new SandboxedCheckRunner({ factoryHome: io.home }) },
      ...io.doctor,
    },
    { baseline: values.baseline },
  ).finally(async () => {
    // Its network proxy would otherwise keep the process alive.
    await sandboxes.agent.close();
    await sandboxes.check.close();
  });
  io.stdout.write(renderSelfChecks(checks));
  const failed = checks.filter((c) => !c.ok).length;
  io.stdout.write(failed ? `${failed} check${failed === 1 ? "" : "s"} failed.\n` : "Every check passed.\n");
  return failed ? 1 : 0;
}

/** Shows the proposal and asks: write it, edit it in $EDITOR, or not. */
async function confirmInTerminal(proposal: string, problems: string[], io: OnboardingIo): Promise<Confirmation> {
  io.stdout.write(`\nProposed for factory.yaml:\n\n${proposal}\n`);
  if (problems.length) io.stdout.write(`That doesn't pass the config check:\n${problems.map((p) => `  - ${p}\n`).join("")}\n`);
  for (;;) {
    const answer = await (io.ask ?? askInTerminal)(problems.length ? "[e]dit again or [n]o? " : "Write this to factory.yaml? [y]es, [e]dit, [n]o: ");
    if (answer === null) throw new Error("No terminal to confirm the proposal in: run with --yes to accept it as proposed.");
    const a = answer.trim().toLowerCase();
    if ((a === "y" || a === "yes") && !problems.length) return { kind: "yes" };
    if (a === "n" || a === "no") return { kind: "no" };
    if (a === "e" || a === "edit") return { kind: "edited", text: editInEditor(proposal, io.home) };
  }
}

function editInEditor(text: string, home: string): string {
  const file = join(home, "repo-add.proposal.yaml");
  writeFileSync(file, text, { mode: 0o600 });
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "editor", file], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${editor} exited ${r.status}.`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(file, { force: true });
  }
}

async function askInTerminal(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
