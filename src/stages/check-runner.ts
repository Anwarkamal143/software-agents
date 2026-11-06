import { spawn } from "node:child_process";

export interface CheckRun {
  passed: boolean;
  /** The first command that failed; later commands don't run. */
  failed: { command: string; exit_code: number | null; timed_out?: boolean } | null;
  /** Each command line, then its stdout and stderr interleaved. */
  output: string;
}

export interface CheckRequest {
  commands: string[];
  cwd: string;
  /** Per command. Default 30 minutes, the default Stage-run Budget. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs a Check Stage's commands. The Orchestrator runs these itself, with no agent involved. */
export interface CheckRunner {
  run(request: CheckRequest): Promise<CheckRun>;
}

/**
 * Plain shell commands, one after another, stopping at the first failure.
 * Not sandboxed: Check Stages under sandbox-runtime come in #29.
 */
export class ShellCheckRunner implements CheckRunner {
  async run({ commands, cwd, timeoutMs = 30 * 60_000, signal }: CheckRequest): Promise<CheckRun> {
    let output = "";
    for (const command of commands) {
      output += `$ ${command}\n`;
      const { code, timedOut, text } = await runOne(command, cwd, timeoutMs, signal);
      output += text;
      if (code !== 0) {
        return { passed: false, failed: { command, exit_code: code, ...(timedOut && { timed_out: true }) }, output };
      }
    }
    return { passed: true, failed: null, output };
  }
}

function runOne(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ code: number | null; timedOut: boolean; text: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, signal });
    let text = "";
    let timedOut = false;
    child.stdout.on("data", (b: Buffer) => (text += b.toString()));
    child.stderr.on("data", (b: Buffer) => (text += b.toString()));
    // Kill the whole process group, so a shell's children don't outlive it.
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        kill();
        resolve({ code: null, timedOut: false, text });
      } else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, text });
    });
  });
}
