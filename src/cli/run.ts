import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { printLogs } from "./logs.js";
import { doctorCommand, initCommand, repoCommand, secretCommand, type OnboardingIo } from "./onboarding.js";
import { factoryRun } from "./factory-run.js";
import { parseReplyCommand } from "../humans/commands.js";
import { recordReply, type IgnoredWhy } from "../humans/replies.js";
import { EventLog } from "../jobs/event-log.js";
import { homePaths } from "../home.js";
import { JobProjection, type JobState } from "../jobs/projection.js";
import type { FactoryEvent } from "../events/envelope.js";
import type { JobStore } from "../store/job-store.js";
import { openSqliteJobStore } from "../store/sqlite-job-store.js";

export interface CliIo extends OnboardingIo {
  /** Stops a command that keeps running, such as `logs --follow`. */
  signal?: AbortSignal;
}

const USAGE = `Usage: factory <command>

Setup:
  init [--token] [--org <org>]
                            Create the Factory home, its own GitHub App (or store a personal
                            token from stdin with --token), a starter factory.yaml and gitleaks
  repo add <owner/repo> [--secret <NAME>]... [--yes] [--skip-baseline] [--backfill]
                            Add a Target repo: propose its Check Stages and network allowlist,
                            ask for its check secrets (not shown), run the Baseline check,
                            create its labels and write factory.yaml
  secret set <owner/repo> <NAME>
                            Read a check secret from stdin into the keychain
  doctor [--baseline]       Run the self-checks (and with --baseline, each repo's Baseline check)

Commands:
  run                       Run the Factory in the foreground until Ctrl-C
  status                    List Jobs with their status, Stage, reason and estimated cost
  logs <job> [--follow]     One Job's events with each Stage run's Transcript; --follow keeps going
  events [--from <seq>] [--json]
                            Print the Event log from a seq (default 1)
  config check [<file>]     Check factory.yaml (default: the one in the Factory home)
  answer <job> <option>     Answer a waiting Job's question: A, B, C or other: <text>
  approve <job>             Approve what a waiting Job asked for
  reject <job> <reason>     Reject it: the Job Bounces to build with the reason as a finding
  cancel <job>              Cancel a waiting Job
  retry <job>               Start a failed or cancelled Job's next Attempt
`;

/** The `factory` CLI, in-process. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "init":
        return await initCommand(rest, io);
      case "repo":
        return await repoCommand(rest, io);
      case "secret":
        return await secretCommand(rest, io);
      case "doctor":
        return await doctorCommand(rest, io);
      case "run":
        await factoryRun(io.home, io.signal ?? new AbortController().signal, (s) => io.stderr.write(s));
        return 0;
      case "status":
        return status(io);
      case "events":
        return events(rest, io);
      case "logs":
        return await logs(rest, io);
      case "answer":
      case "approve":
      case "reject":
      case "cancel":
        return reply(command, rest, io);
      case "retry":
        return retry(rest, io);
      case "config":
        if (rest[0] === "check") return configCheck(rest.slice(1), io);
        break;
      case "help":
      case "--help":
      case "-h":
        io.stdout.write(USAGE);
        return 0;
    }
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stderr.write(USAGE);
  return 2;
}

/** Opens the Job store read-side, or returns null if the Factory has never run. */
function openStore(home: string): JobStore | null {
  const path = homePaths(home).jobStore;
  return existsSync(path) ? openSqliteJobStore(path) : null;
}

function status(io: CliIo): number {
  const store = openStore(io.home);
  const projection = new JobProjection();
  for (const event of store?.read() ?? []) projection.apply(event);
  store?.close();
  const jobs: JobState[] = projection.all();
  const pause = projection.pause();
  if (pause) io.stdout.write(`${describePause(pause)}\n`);
  if (!jobs.length) {
    io.stdout.write("No Jobs yet.\n");
    return 0;
  }
  const rows = [
    ["JOB", "ISSUE", "STATUS", "STAGE", "REASON", "COST (EST.)"],
    ...jobs.map((j) => [j.job_id, `${j.repo}#${j.issue}`, j.status, j.stage ?? "-", j.reason ?? "-", `$${j.cost_usd.toFixed(2)}`]),
  ];
  io.stdout.write(table(rows));
  // Waiting, paused and queued Jobs are never stuck; a long queue only warns (ADR 0010).
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const j of jobs) if (j.status === "queued" && Date.parse(j.updated_at) < dayAgo) io.stdout.write(`warning: Job ${j.job_id} has been queued for over a day.\n`);
  return 0;
}

function describePause(pause: FactoryEvent): string {
  if (pause.type === "plan-limit-hit") {
    const until = typeof pause.data.resets_at === "string" ? ` until ${pause.data.resets_at}` : "";
    return `The Factory is paused (plan-limit)${until}.`;
  }
  const reason = typeof pause.data.reason === "string" ? ` (${pause.data.reason})` : "";
  const message = typeof pause.data.message === "string" ? `: ${pause.data.message}` : ".";
  return `The Factory is paused${reason}${message}`;
}

function events(args: string[], io: CliIo): number {
  const { values } = parseArgs({ args, options: { from: { type: "string", default: "1" }, json: { type: "boolean", default: false } } });
  const from = Number(values.from);
  if (!Number.isInteger(from) || from < 1) throw new Error(`--from must be a seq (a whole number from 1), not "${values.from}".`);
  const store = openStore(io.home);
  for (const e of store?.read(from) ?? []) {
    io.stdout.write(
      values.json
        ? `${JSON.stringify(e)}\n`
        : `${e.seq} ${e.at} ${e.type} ${e.job_id ?? "-"} ${e.actor} ${JSON.stringify(e.data)}\n`,
    );
  }
  store?.close();
  return 0;
}

async function logs(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { follow: { type: "boolean", short: "f", default: false } } });
  const [job_id] = positionals;
  if (!job_id) {
    io.stderr.write("Usage: factory logs <job> [--follow]\n");
    return 2;
  }
  const store = openStore(io.home);
  if (!store) throw new Error("The Factory has no Jobs yet.");
  try {
    if (!store.read().some((e) => e.job_id === job_id)) throw new Error(`No Job ${job_id}.`);
    await printLogs(store, io.home, job_id, (s) => io.stdout.write(s), { follow: values.follow, ...(io.signal && { signal: io.signal }) });
    return 0;
  } finally {
    store.close();
  }
}

/** The CLI channel for Reply commands: parsed exactly like a comment, recorded like one (ADR 0006). */
function reply(command: string, args: string[], io: CliIo): number {
  const [job_id, ...words] = args;
  if (!job_id) {
    io.stderr.write(`Usage: factory ${command} <job>${command === "answer" ? " <option>" : command === "reject" ? " <reason>" : ""}\n`);
    return 2;
  }
  const parsed = parseReplyCommand([`/${command}`, ...words].join(" "));
  if (parsed.kind !== "command") {
    io.stderr.write(`${parsed.kind === "malformed" ? parsed.why : "Not a Reply command."}\n`);
    return 2;
  }
  const store = openStore(io.home);
  if (!store) throw new Error("The Factory has no Jobs yet.");
  try {
    const log = new EventLog(store);
    if (!log.job(job_id)) throw new Error(`No Job ${job_id}.`);
    const outcome = recordReply(log, { job_id, channel: "cli", created_at: new Date().toISOString(), command: parsed.command });
    if (outcome.kind === "answered") {
      io.stdout.write(`Recorded /${command} for Job ${job_id}. The Factory acts on it at its next step.\n`);
      return 0;
    }
    io.stderr.write(`${IGNORED_MESSAGE[outcome.why](job_id)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

/** Only a human starts a new Attempt (ADR 0010): recorded here, started by the Orchestrator at its next step. */
function retry(args: string[], io: CliIo): number {
  const [job_id] = args;
  if (!job_id) {
    io.stderr.write("Usage: factory retry <job>\n");
    return 2;
  }
  const store = openStore(io.home);
  if (!store) throw new Error("The Factory has no Jobs yet.");
  try {
    const log = new EventLog(store);
    const job = log.job(job_id);
    if (!job) throw new Error(`No Job ${job_id}.`);
    if (job.status !== "failed" && job.status !== "cancelled") {
      io.stderr.write(`Job ${job_id} is ${job.status}: only a failed or cancelled Job can be retried.\n`);
      return 1;
    }
    log.record({ type: "job-retried", job_id, attempt: job.attempt, actor: "cli" });
    io.stdout.write(`Recorded. The Factory starts Job ${job_id}'s Attempt ${job.attempt + 1} at its next step.\n`);
    return 0;
  } finally {
    store.close();
  }
}

/** What the CLI says when its reply doesn't count. The GitHub-only reasons never reach it. */
const IGNORED_MESSAGE: Record<IgnoredWhy, (job: string) => string> = {
  "not-allowed": () => "Not recorded: not allowed.",
  "no-write-access": () => "Not recorded: no write access.",
  "edited-after-recording": () => "Not recorded: that reply was already recorded.",
  "before-request": (job) => `Job ${job}'s request is newer than this reply.`,
  malformed: () => "Not a Reply command.",
  "already-answered": (job) => `Job ${job}'s request was already answered.`,
  "not-waiting": (job) => `Job ${job} isn't waiting on a Human request.`,
  "wrong-command": () => "That command doesn't answer this request: a question takes answer or cancel, an approval takes approve, reject or cancel.",
  "no-such-option": () => "The question has no such option.",
};

function configCheck(args: string[], io: CliIo): number {
  const file = args[0] ?? homePaths(io.home).config;
  if (!existsSync(file)) {
    io.stderr.write(`No config at ${file}.\n`);
    return 1;
  }
  const result = loadConfig(readFileSync(file, "utf8"));
  if (result.ok) io.stdout.write(`${file} passes.\n`);
  else io.stderr.write(`${file} fails:\n${result.problems.map((p) => `  - ${p}\n`).join("")}`);
  for (const w of result.warnings) io.stdout.write(`warning: ${w}\n`);
  return result.ok ? 0 : 1;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n") + "\n";
}
