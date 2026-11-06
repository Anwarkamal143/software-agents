import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface CheckRun {
  passed: boolean;
  /** The first command that failed; later commands don't run. */
  failed: { command: string; exit_code: number | null; timed_out?: boolean } | null;
  /** Each command line, then its stdout and stderr interleaved. */
  output: string;
  /** What the Sandbox blocked, one line each, in the order seen. */
  violations: string[];
}

export interface CheckRequest {
  commands: string[];
  /** The Check Stage copy: the commands may read and write here. */
  cwd: string;
  /** Added to a minimal environment (PATH only); nothing else of the Orchestrator's leaks in. */
  env?: Record<string, string>;
  /** Other folders the commands may read and write: the Attempt's HOME, caches and temp folder. */
  writable?: string[];
  /** The only hosts the commands may reach. Default none. */
  network?: string[];
  /** Per command. Default 30 minutes, the default Stage-run Budget. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs a Check Stage's commands. The Orchestrator runs these itself, with no agent involved. */
export interface CheckRunner {
  /** Throws `SandboxUnavailable` if the commands can't be confined: they never run unsandboxed. */
  run(request: CheckRequest): Promise<CheckRun>;
}

/** The Sandbox can't start here. A Factory fault, never a reason to run unconfined (ADR 0007, ADR 0010). */
export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable";
}

/** What one command may touch. */
export interface SandboxPolicy {
  /** Readable and writable, even inside a denied folder. */
  readWrite: string[];
  /** Unreadable, unless inside `readWrite`. */
  denyRead: string[];
  /** Unreadable everywhere, `readWrite` included: glob patterns. */
  denyReadPatterns: string[];
  network: string[];
}

export interface WrappedCommand {
  /** A shell command line that runs the original under the Sandbox. */
  command: string;
  /**
   * Call as soon as the command has exited: it closes the command's network allowlist at once,
   * and resolves to what the Sandbox blocked while it ran once the OS has reported it.
   */
  finish(): Promise<string[]>;
}

/** The OS-level Sandbox. `srtSandbox` is the real one. */
export interface Sandbox {
  /** Throws `SandboxUnavailable` if commands can't be confined on this machine. */
  ready(): Promise<void>;
  wrap(command: string, policy: SandboxPolicy): Promise<WrappedCommand>;
  close(): Promise<void>;
}

/** Credential folders and files in the user's home no Check Stage reads. */
const HOME_CREDENTIALS = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube", ".netrc", ".npmrc"];

/**
 * Check Stage commands under the Sandbox (ADR 0007): they run code an agent wrote, so they
 * write only to the Check Stage copy and the Attempt's own folders, can't read `.env*`, home
 * credentials or the Factory home, and reach only the repo's allowlisted hosts.
 */
export class SandboxedCheckRunner implements CheckRunner {
  private readonly sandbox: Sandbox;
  private readonly factoryHome: string;
  private readonly userHome: string;

  constructor({ factoryHome, userHome = homedir(), sandbox = srtSandbox }: { factoryHome: string; userHome?: string; sandbox?: Sandbox }) {
    this.factoryHome = factoryHome;
    this.userHome = userHome;
    this.sandbox = sandbox;
  }

  async run({ commands, cwd, env = {}, writable = [], network = [], timeoutMs = 30 * 60_000, signal }: CheckRequest): Promise<CheckRun> {
    await this.sandbox.ready();
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
    const readWrite = [cwd, ...writable].map(real);
    const policy: SandboxPolicy = {
      readWrite,
      denyRead: [real(this.factoryHome), ...HOME_CREDENTIALS.map((p) => join(real(this.userHome), p))],
      denyReadPatterns: readWrite.map((d) => `${d}/**/.env*`),
      network,
    };
    // PATH last, so a check secret can't replace it.
    const fullEnv = { ...env, PATH: process.env.PATH ?? "" };
    let output = "";
    // Collected together at the end, so the wait for the OS's reports overlaps.
    const reports: Promise<string[]>[] = [];
    const done = async (run: Omit<CheckRun, "violations">): Promise<CheckRun> => ({ ...run, violations: (await Promise.all(reports)).flat() });
    for (const command of commands) {
      output += `$ ${command}\n`;
      let wrapped: WrappedCommand;
      try {
        wrapped = await this.sandbox.wrap(command, policy);
      } catch (err) {
        throw err instanceof SandboxUnavailable ? err : new SandboxUnavailable(`Couldn't sandbox \`${command}\`: ${String(err)}`);
      }
      // Asynchronously: the Sandbox's network proxy runs in this process, and a blocked event loop starves it.
      let result;
      try {
        result = await runOne(wrapped.command, cwd, fullEnv, timeoutMs, signal);
      } finally {
        reports.push(wrapped.finish());
      }
      output += result.text;
      if (result.code !== 0) {
        return done({ passed: false, failed: { command, exit_code: result.code, ...(result.timedOut && { timed_out: true }) }, output });
      }
    }
    return done({ passed: true, failed: null, output });
  }
}

/** How long to wait for the OS to report what it blocked after a command exits. */
const VIOLATION_SETTLE_MS = 300;

let initialized: Promise<void> | null = null;

/**
 * `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS, bubblewrap on Linux. One per process,
 * initialized on first use; each command gets its own filesystem policy and network allowlist.
 */
export const srtSandbox: Sandbox = {
  async ready() {
    if (!SandboxManager.isSupportedPlatform()) throw new SandboxUnavailable(`The Sandbox doesn't support ${process.platform}.`);
    const deps = await SandboxManager.checkDependenciesAsync();
    if (deps.errors.length) throw new SandboxUnavailable(`The Sandbox can't start: ${deps.errors.join("; ")}`);
    initialized ??= SandboxManager.initialize(
      // Every host is denied unless a command's own allowlist names it; no ask callback, so nothing is asked.
      { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
      undefined,
      true,
    ).catch((err: unknown) => {
      initialized = null;
      throw new SandboxUnavailable(`The Sandbox can't start: ${String(err)}`);
    });
    await initialized;
  },

  async wrap(command, policy) {
    // Unguessable: the id is all that ties a connection to this command's allowlist.
    const commandId = randomBytes(16).toString("base64url");
    const literal = (path: string) => ({ path, literal: true as const });
    const config: Partial<SandboxRuntimeConfig> = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [...policy.denyRead.map(literal), ...policy.denyReadPatterns],
        allowRead: policy.readWrite.map(literal),
        allowWrite: policy.readWrite.map(literal),
        denyWrite: [],
      },
    };
    SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: policy.network });
    try {
      const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, config, undefined, { commandId, commandText: command });
      return {
        command: wrapped,
        async finish() {
          SandboxManager.unregisterCommandNetworkLists(commandId);
          // Seatbelt's denials reach the log monitor a little after the command exits.
          await new Promise((r) => setTimeout(r, VIOLATION_SETTLE_MS));
          return SandboxManager.getSandboxViolationStore()
            .getViolationsForCommand(commandId)
            .map((v) => v.line);
        },
      };
    } catch (err) {
      SandboxManager.unregisterCommandNetworkLists(commandId);
      throw err;
    }
  },

  async close() {
    if (!initialized) return;
    initialized = null;
    await SandboxManager.reset();
  },
};

function runOne(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ code: number | null; timedOut: boolean; text: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, signal });
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
