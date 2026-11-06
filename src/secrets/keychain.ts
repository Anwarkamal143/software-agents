import { execFile } from "node:child_process";

/** Where Factory credentials and check secrets live (ADR 0007): never in `factory.yaml`, never in the Orchestrator's env. */
export interface SecretStore {
  /** The secret stored under `name`, or null if there is none. */
  get(name: string): Promise<string | null>;
}

/** The keychain service every Factory secret is stored under. */
export const KEYCHAIN_SERVICE = "software-factory";

/** The OS keychain: the macOS login keychain, or the Secret Service (`secret-tool`) on Linux. */
export class OsKeychain implements SecretStore {
  constructor(private readonly service = KEYCHAIN_SERVICE) {}

  get(name: string): Promise<string | null> {
    const [file, args] =
      process.platform === "darwin"
        ? ["security", ["find-generic-password", "-s", this.service, "-a", name, "-w"]]
        : ["secret-tool", ["lookup", "service", this.service, "name", name]];
    return new Promise((resolve, reject) => {
      execFile(file, args, { encoding: "utf8" }, (err, stdout) => {
        // Both exit non-zero when nothing is stored under the name.
        if (err && typeof err.code === "number") return resolve(null);
        if (err) return reject(err);
        // `security -w` ends the password with a newline.
        resolve(process.platform === "darwin" ? stdout.replace(/\n$/, "") : stdout);
      });
    });
  }
}
