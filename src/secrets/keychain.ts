import { spawn } from "node:child_process";

/** Where Factory credentials and check secrets live (ADR 0007): never in `factory.yaml`, never in the Orchestrator's env. */
export interface SecretStore {
  /** The secret stored under `name`, or null if there is none. */
  get(name: string): Promise<string | null>;
}

/** A SecretStore that `factory init` and `factory secret set` can write to. */
export interface WritableSecretStore extends SecretStore {
  set(name: string, value: string): Promise<void>;
}

/** The keychain service every Factory secret is stored under. */
export const KEYCHAIN_SERVICE = "software-factory";

/**
 * The keychain name a Target repo's check secret is stored under: `check.<owner>.<repo>.<NAME>`.
 * Per repo, so two repos' `DATABASE_URL`s never meet, and never one of the Factory's own credentials.
 * Owners and `NAME`s have no dots, so the name can't be read back as another repo's.
 */
export function checkSecretKey(repo: string, name: string): string {
  const [owner, repoName] = repo.split("/");
  return `check.${owner}.${repoName}.${name}`;
}

/** Runs the OS keychain tool, with `stdin` as its input. */
export type RunSecurityTool = (file: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

/** Names are plain identifiers, so they are safe on a command line. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** Values `security -i` can take as one bare word; anything else is stored base64-encoded behind this prefix. */
const BARE = /^[A-Za-z0-9_.\-+/=:@%]+$/;
const ENCODED = "factory-base64:";

/**
 * The OS keychain: the macOS login keychain (`security`), or the Secret Service (`secret-tool`)
 * on Linux. Values go to the tool over stdin, never as arguments other processes could see.
 */
export class OsKeychain implements WritableSecretStore {
  private readonly platform: NodeJS.Platform;
  private readonly run: RunSecurityTool;

  constructor(
    private readonly service = KEYCHAIN_SERVICE,
    options: { platform?: NodeJS.Platform; run?: RunSecurityTool } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runTool;
  }

  async get(name: string): Promise<string | null> {
    const darwin = this.platform === "darwin";
    const { code, stdout } = darwin
      ? await this.run("security", ["find-generic-password", "-s", this.service, "-a", name, "-w"])
      : await this.run("secret-tool", ["lookup", "service", this.service, "name", name]);
    // Both exit non-zero when nothing is stored under the name.
    if (code !== 0) return null;
    // `security -w` ends the password with a newline.
    const value = darwin ? stdout.replace(/\n$/, "") : stdout;
    return value.startsWith(ENCODED) ? Buffer.from(value.slice(ENCODED.length), "base64").toString("utf8") : value;
  }

  async set(name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new Error(`"${name}" isn't a secret name: use letters, digits and _ . -, starting with a letter or _.`);
    const result =
      this.platform === "darwin"
        ? await this.run("security", ["-i"], `add-generic-password -U -s ${this.service} -a ${name} -w ${BARE.test(value) ? value : ENCODED + Buffer.from(value, "utf8").toString("base64")}\n`)
        : await this.run("secret-tool", ["store", `--label=Software Factory: ${name}`, "service", this.service, "name", name], value);
    if (result.code !== 0) throw new Error(`Couldn't store ${name} in the keychain (exit ${result.code}).`);
  }
}

const runTool: RunSecurityTool = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(stdin ?? "");
  });
