import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import type { GitHubClient } from "../github/client.js";
import { homePaths } from "../home.js";
import { SOURCE_CURSOR } from "../orchestrator/orchestrator.js";
import type { Clones } from "../repos/clones.js";
import { seedRepoCursor } from "../source/github.js";
import type { CheckRunner } from "../stages/check-runner.js";
import type { JobStore } from "../store/job-store.js";
import { baselineCheck } from "./baseline.js";
import { addRepo, parseRepoEntry, renderRepoEntry, repoEntry, type RepoEntry } from "./config-edit.js";
import { ensureLabels } from "./labels.js";
import { proposeRepo } from "./propose.js";

/** Your answer to a proposal: write it, don't, or write this edited version of it. */
export type Confirmation = { kind: "yes" } | { kind: "no" } | { kind: "edited"; text: string };

export interface RepoAddDeps {
  home: string;
  clones: Clones;
  checks: CheckRunner;
  github: GitHubClient;
  /** Opened only once the proposal is confirmed and passed its Baseline check. */
  openStore: () => JobStore;
  /** Shows the proposal (YAML) and asks. Asked again, with the problems, if an edit doesn't pass. */
  confirm: (proposal: string, problems: string[]) => Promise<Confirmation>;
  out: (s: string) => void;
  now?: () => Date;
}

export interface RepoAddOptions {
  skipBaseline?: boolean;
  /** Also pick up issues already labelled ready, each still checked in the timeline for an allowed person. */
  backfill?: boolean;
}

export type RepoAddOutcome = "added" | "already-added" | "declined" | "refused";

/**
 * `factory repo add <owner/repo>` (ADR 0011): makes the Trusted clone, proposes Check Stages and a
 * network allowlist from what's in the repo, and once you confirm (or edit) them, runs the
 * Baseline check. Only a green baseline (or `--skip-baseline`) creates the Factory's labels,
 * starts the repo's first poll from now (or from the beginning with `--backfill`) and writes its
 * entry in `factory.yaml`. Running it again for a repo already there changes nothing.
 */
export async function repoAdd(name: string, options: RepoAddOptions, deps: RepoAddDeps): Promise<RepoAddOutcome> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`"${name}" isn't a repo: use owner/repo.`);
  const path = homePaths(deps.home).config;
  if (!existsSync(path)) throw new Error(`No config at ${path}: run \`factory init\` first.`);
  const text = readFileSync(path, "utf8");
  const loaded = loadConfig(text);
  if (!loaded.ok) throw new Error(`${path} doesn't pass \`factory config check\`; fix it first:\n${loaded.problems.map((p) => `  - ${p}`).join("\n")}`);
  const readyLabel = loaded.config.sources[0]?.ready_label ?? "factory:ready";

  if (loaded.config.repos.some((r) => r.name === name)) {
    const created = await ensureLabels(deps.github, name, readyLabel);
    deps.out(`${name} is already in factory.yaml; nothing to change there.${created.length ? ` Created missing labels: ${created.join(", ")}.` : ""}\n`);
    return "already-added";
  }

  deps.out(`Cloning ${name} into the Factory home…\n`);
  const head = await deps.clones.defaultHead(name);
  const files = new Map<string, string | null>();
  for (const file of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.mod", "Cargo.toml"]) files.set(file, await deps.clones.readFile(name, head, file));
  let entry: RepoEntry = repoEntry(name, proposeRepo((p) => files.get(p) ?? null));

  // Nothing is written until you confirm, and the confirmed entry must pass the config check.
  let problems: string[] = [];
  let updated: string;
  for (;;) {
    const answer = await deps.confirm(renderRepoEntry(entry), problems);
    if (answer.kind === "no") {
      deps.out("Nothing written.\n");
      return "declined";
    }
    if (answer.kind === "edited") {
      const parsed = parseRepoEntry(answer.text, name);
      if (!parsed.ok) {
        problems = [parsed.problem];
        continue;
      }
      entry = parsed.entry;
    }
    const added = addRepo(text, entry);
    if (added.ok) {
      updated = added.text;
      break;
    }
    problems = added.problems;
  }

  if (options.skipBaseline) deps.out("Skipping the Baseline check (--skip-baseline).\n");
  else {
    deps.out(`Running the Baseline check on ${name}'s default branch (${head.slice(0, 7)})…\n`);
    const baseline = await baselineCheck(deps.clones, deps.checks, { repo: name, checks: entry.repo.commands ?? {}, network: entry.repo.network ?? [] });
    if (!baseline.passed) {
      deps.out(
        `Refused: the Baseline check failed. Check Stage "${baseline.check}": \`${baseline.command}\` exited ${baseline.exit_code}.\n` +
          `${tail(baseline.output)}\nEvery Job here would fail. Fix the default branch, or add it anyway with --skip-baseline. Nothing written.\n`,
      );
      return "refused";
    }
    deps.out("The Baseline check passed.\n");
  }

  const created = await ensureLabels(deps.github, name, readyLabel);
  if (created.length) deps.out(`Created labels: ${created.join(", ")}.\n`);
  const store = deps.openStore();
  try {
    const from = options.backfill ? new Date(0) : (deps.now?.() ?? new Date());
    store.saveCursor(SOURCE_CURSOR, seedRepoCursor(store.cursor(SOURCE_CURSOR), name, from));
  } finally {
    store.close();
  }
  writeFileSync(`${path}.tmp`, updated, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  deps.out(`Added ${name} to factory.yaml. ${options.backfill ? "Issues already labelled" : "Issues labelled"} ${readyLabel} by someone on humans become Jobs at the next poll.\n`);
  return "added";
}

function tail(output: string, lines = 20): string {
  return output.trimEnd().split("\n").slice(-lines).map((l) => `  ${l}`).join("\n");
}
