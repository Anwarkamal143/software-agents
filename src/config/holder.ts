import { readFileSync } from "node:fs";
import { hashConfigText, loadConfig } from "./load.js";
import type { FactoryConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file} fails factory config check:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/**
 * The config in effect. The Orchestrator calls `refresh()` before each Stage
 * run, so edits apply at the next one; an edit that fails the check is
 * rejected and the previous config stays (ADR 0005, ADR 0010).
 */
export class ConfigHolder {
  private constructor(
    readonly file: string,
    private config: FactoryConfig,
    private configHash: string,
  ) {}

  /** Loads `file`, throwing a ConfigError if it fails the check: the Orchestrator refuses to start. */
  static open(file: string): ConfigHolder {
    const text = readFileSync(file, "utf8");
    const loaded = loadConfig(text);
    if (!loaded.ok) throw new ConfigError(file, loaded.problems);
    return new ConfigHolder(file, loaded.config, loaded.hash);
  }

  get current(): FactoryConfig {
    return this.config;
  }

  /** sha256 of the config text in effect; each Stage run records it. */
  get hash(): string {
    return this.configHash;
  }

  /** Re-reads the file. `changed` is true only when a new config passed the check and took effect. */
  refresh(): { changed: boolean; problems: string[] } {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      return { changed: false, problems: [`Can't read ${this.file}: ${(err as Error).message}`] };
    }
    if (hashConfigText(text) === this.configHash) return { changed: false, problems: [] };
    const loaded = loadConfig(text);
    if (!loaded.ok) return { changed: false, problems: loaded.problems };
    this.configHash = loaded.hash;
    this.config = loaded.config;
    return { changed: true, problems: [] };
  }
}
