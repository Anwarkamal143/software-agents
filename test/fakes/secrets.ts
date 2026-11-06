import type { SecretStore } from "../../src/secrets/keychain.js";

/** A keychain in memory that records which names were read. */
export class FakeSecrets implements SecretStore {
  read: string[] = [];

  constructor(private readonly secrets: Record<string, string> = {}) {}

  async get(name: string): Promise<string | null> {
    this.read.push(name);
    return this.secrets[name] ?? null;
  }
}
