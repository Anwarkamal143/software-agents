import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Config every Orchestrator git call carries, whatever repo it touches: no hooks,
 * no fsmonitor, only file and https transports, and objects checked on the way in.
 * Command-line config outranks anything a repo's own `.git/config` sets.
 */
const HARDENING = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.sshCommand=false",
  "protocol.allow=never",
  "protocol.file.allow=always",
  "protocol.https.allow=always",
  "transfer.fsckObjects=true",
  "submodule.recurse=false",
  "advice.detachedHead=false",
].flatMap((c) => ["-c", c]);

/** upload-pack runs inside the repo being fetched from, so it gets the same overrides. */
export const HARDENED_UPLOAD_PACK = `git ${HARDENING.join(" ")} upload-pack`;

export interface GitOptions {
  cwd: string;
  /** Extra environment for this one call, such as `remoteAuthEnv`. */
  env?: Record<string, string>;
}

/**
 * The environment that hands git `token` for an https remote: an `Authorization` header scoped
 * to that remote's URL, as env config so it's never in argv, a remote URL or a config file.
 * Nothing for any other remote.
 */
export function remoteAuthEnv(remoteUrl: string, token: string): Record<string, string> {
  if (!remoteUrl.startsWith("https://")) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/** Runs git as the Orchestrator: hardened, with no system or global config and an empty HOME. */
export class Git {
  private readonly env: NodeJS.ProcessEnv;

  constructor(emptyHome: string) {
    mkdirSync(emptyHome, { recursive: true });
    this.env = {
      PATH: process.env.PATH,
      HOME: emptyHome,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Software Factory",
      GIT_AUTHOR_EMAIL: "factory@localhost",
      GIT_COMMITTER_NAME: "Software Factory",
      GIT_COMMITTER_EMAIL: "factory@localhost",
    };
  }

  async run(args: string[], { cwd, env }: GitOptions): Promise<string> {
    try {
      const { stdout } = await run("git", [...HARDENING, ...args], { cwd, env: { ...this.env, ...env }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`, { cause: err });
    }
  }

  /** Like `run`, but a non-zero exit is an answer (false), not an error. */
  async test(args: string[], options: GitOptions): Promise<boolean> {
    return this.run(args, options).then(
      () => true,
      () => false,
    );
  }
}
