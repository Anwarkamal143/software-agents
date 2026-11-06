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
});
