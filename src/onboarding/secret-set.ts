import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import { homePaths } from "../home.js";
import type { WritableSecretStore } from "../secrets/keychain.js";
import { addCheckSecret } from "./config-edit.js";

export interface SecretSetDeps {
  home: string;
  secrets: WritableSecretStore;
  out: (s: string) => void;
}

/**
 * `factory secret set <repo> <NAME>` (ADR 0011): reads a check secret from stdin into the
 * keychain, so it never lands in shell history, a file or `factory.yaml`, which only names it.
 * The repo's Check Stages get it as the env var `NAME`.
 */
export async function secretSet(repo: string, name: string, readValue: () => Promise<string>, deps: SecretSetDeps): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" isn't a check secret name: it becomes an env var, so use letters, digits and _, such as DATABASE_URL.`);
  const path = homePaths(deps.home).config;
  if (!existsSync(path)) throw new Error(`No config at ${path}: run \`factory init\` first.`);
  const text = readFileSync(path, "utf8");
  // Checked before reading the value, so a mistake costs no typing.
  const updated = addCheckSecret(text, repo, name);
  const value = (await readValue()).replace(/\r?\n$/, "");
  if (!value) throw new Error("The value is empty: pipe it in, or type it and press Ctrl-D.");
  await deps.secrets.set(name, value);
  if (updated !== text) {
    const loaded = loadConfig(updated);
    if (!loaded.ok) throw new Error(`Stored ${name} in the keychain, but naming it in factory.yaml would fail the config check:\n${loaded.problems.map((p) => `  - ${p}`).join("\n")}`);
    writeFileSync(`${path}.tmp`, updated, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  deps.out(`Stored ${name} in the keychain. ${repo}'s Check Stages get it as $${name}.\n`);
}
