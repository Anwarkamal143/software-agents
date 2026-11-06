import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
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
