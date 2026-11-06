import { readFileSync } from "node:fs";
import { loadConfig } from "../../src/config/load.js";
import type { FactoryConfig } from "../../src/config/types.js";

export const fixture = (name: string) => readFileSync(new URL(`../fixtures/config/${name}`, import.meta.url), "utf8");

/** The draft fixture, which must load cleanly. */
export function draftConfig(): FactoryConfig {
  const loaded = loadConfig(fixture("draft.yaml"));
  if (!loaded.ok) throw new Error(`draft.yaml should load: ${loaded.problems.join("\n")}`);
  return loaded.config;
}
