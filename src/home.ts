import { homedir } from "node:os";
import { join } from "node:path";

/** The Factory home: config, Job store and artifacts. `FACTORY_HOME` overrides `~/.factory`. */
export function factoryHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTORY_HOME || join(homedir(), ".factory");
}

export const homePaths = (home: string) => ({
  config: join(home, "factory.yaml"),
  jobStore: join(home, "factory.db"),
  artifacts: join(home, "artifacts"),
  /** One NDJSON Transcript per Stage run, under a folder per Job (ADR 0009). */
  transcripts: join(home, "transcripts"),
  /** Every Attempt's Working copy, under a folder per Job (ADR 0008). */
  work: join(home, "work"),
  /** Mirror writes saved before they're sent, one folder per Mirror (ADR 0002). */
  outbox: join(home, "outbox"),
});
