import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { parseReplyCommand } from "../humans/commands.js";
import { recordReply } from "../humans/replies.js";
import { EventLog } from "../jobs/event-log.js";
import { homePaths } from "../home.js";
import { computeJobs, type JobState } from "../jobs/projection.js";
import type { JobStore } from "../store/job-store.js";
import { openSqliteJobStore } from "../store/sqlite-job-store.js";

export interface CliIo {
  home: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
}

const USAGE = `Usage: factory <command>

Commands:
  status                    List Jobs with their status, Stage, reason and estimated cost
  events [--from <seq>] [--json]
                            Print the Event log from a seq (default 1)
  config check [<file>]     Check factory.yaml (default: the one in the Factory home)
  answer <job> <option>     Answer a waiting Job's question: A, B, C or other: <text>
  approve <job>             Approve what a waiting Job asked for
  reject <job> <reason>     Reject it: the Job Bounces to build with the reason as a finding
  cancel <job>              Cancel a waiting Job
`;

/** The `factory` CLI, in-process. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "status":
        return status(io);
      case "events":
        return events(rest, io);
      case "answer":
      case "approve":
      case "reject":
      case "cancel":
        return reply(command, rest, io);
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
  const jobs: JobState[] = store ? [...computeJobs(store.read()).values()] : [];
  store?.close();
  if (!jobs.length) {
    io.stdout.write("No Jobs yet.\n");
    return 0;
  }
  const rows = [
    ["JOB", "ISSUE", "STATUS", "STAGE", "REASON", "COST (EST.)"],
    ...jobs.map((j) => [j.job_id, `${j.repo}#${j.issue}`, j.status, j.stage ?? "-", j.reason ?? "-", `$${j.cost_usd.toFixed(2)}`]),
  ];
  io.stdout.write(table(rows));
  return 0;
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
    io.stderr.write(`${IGNORED_MESSAGE[outcome.why]?.(job_id) ?? `Not recorded: ${outcome.why}.`}\n`);
    return 1;
  } finally {
    store.close();
  }
}

const IGNORED_MESSAGE: Partial<Record<string, (job: string) => string>> = {
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
