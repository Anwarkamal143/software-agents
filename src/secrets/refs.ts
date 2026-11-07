import type { SecretStore } from "./keychain.js";

/** A `${env:NAME}` or `keychain:NAME` reference from `factory.yaml`, resolved; null if unset. */
export async function resolveSecretRef(ref: string | undefined, secrets: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!ref) return null;
  const fromEnv = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
  if (fromEnv) return env[fromEnv[1]!] ?? null;
  if (ref.startsWith("keychain:")) return secrets.get(ref.slice("keychain:".length));
  return null;
}
