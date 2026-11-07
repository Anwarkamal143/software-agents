import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isCheckSecretName, loadConfig } from "../config/load.js";
import { homePaths } from "../home.js";
import { checkSecretKey, type WritableSecretStore } from "../secrets/keychain.js";
import { addCheckSecret } from "./config-edit.js";

export interface SecretSetDeps {
  home: string;
  secrets: WritableSecretStore;
  out: (s: string) => void;
}

/**
 * `factory secret set <repo> <NAME>` (ADR 0011): reads a check secret from stdin into the
 * keychain under a name of the repo's own (`checkSecretKey`), so it never lands in shell history,
 * a file or `factory.yaml`, which only names it. The repo's Check Stages that name it in `secrets` get it as the env var `NAME`.
 */
export async function secretSet(repo: string, name: string, readValue: () => Promise<string>, deps: SecretSetDeps): Promise<void> {
  if (!isCheckSecretName(name)) throw new Error(`"${name}" isn't a check secret name: it becomes an env var, so use letters, digits and _, such as DATABASE_URL.`);
  const path = homePaths(deps.home).config;
  if (!existsSync(path)) throw new Error(`No config at ${path}: run \`factory init\` first.`);
  const text = readFileSync(path, "utf8");
  // Checked before reading the value, so a mistake costs no typing.
  const updated = addCheckSecret(text, repo, name);
  const loaded = loadConfig(updated);
  if (updated !== text && !loaded.ok) {
    throw new Error(`Naming ${name} in factory.yaml would fail the config check, so nothing was stored:\n${loaded.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const value = (await readValue()).replace(/\r?\n$/, "");
  if (!value) throw new Error("The value is empty: pipe it in, or type it and press Ctrl-D.");
  await deps.secrets.set(checkSecretKey(repo, name), value);
  if (updated !== text) {
    writeFileSync(`${path}.tmp`, updated, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  // Only the Check Stages that name it get it (ADR 0007).
  const stages = loaded.ok ? Object.entries(loaded.config.stages).filter(([, s]) => s.kind === "check" && s.secrets?.includes(name)).map(([id]) => `"${id}"`) : [];
  const who = stages.length
    ? `Check Stage${stages.length === 1 ? "" : "s"} ${stages.join(", ")} get${stages.length === 1 ? "s" : ""} it as $${name}.`
    : `No Check Stage gets it yet: name it in a Check Stage's secrets in factory.yaml.`;
  deps.out(`Stored ${name} in the keychain for ${repo}. ${who}\n`);
}
