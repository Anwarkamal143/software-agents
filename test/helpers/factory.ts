import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigHolder } from "../../src/config/holder.js";
import { EventLog } from "../../src/jobs/event-log.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { ShellCheckRunner } from "../../src/stages/check-runner.js";
import { ArtifactStore } from "../../src/store/artifact-store.js";
import { openSqliteJobStore } from "../../src/store/sqlite-job-store.js";
import { ScriptedAgent } from "../fakes/agent.js";
import { FakeMirror } from "../fakes/mirror.js";
import { FakeSource } from "../fakes/source.js";
import { fixture } from "./config.js";
import { tmpHome } from "./tmp.js";

/** A whole Factory on fakes: real Event log, config and Check Stages; scripted agent, fake Source and Mirror. */
export function fakeFactory(agent = new ScriptedAgent(), configText = fixture("e2e.yaml")) {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), configText);
  const workdir = join(home, "work");
  mkdirSync(workdir);
  const source = new FakeSource();
  const mirror = new FakeMirror();
  const log = new EventLog(openSqliteJobStore(join(home, "factory.db")));
  const orchestrator = new Orchestrator({
    log,
    config: ConfigHolder.open(join(home, "factory.yaml")),
    source,
    agent,
    checks: new ShellCheckRunner(),
    mirrors: [mirror],
    artifacts: new ArtifactStore(home),
    workdir: () => workdir,
    conventions: () => "Use pnpm.",
  });
  /** Event types for one Job, in order. */
  const types = (job_id: string) => log.store.read().filter((e) => e.job_id === job_id).map((e) => e.type);
  const onlyJob = () => {
    const [job, ...rest] = log.jobs();
    if (!job || rest.length) throw new Error(`expected one Job, found ${log.jobs().length}`);
    return job;
  };
  return { home, workdir, source, mirror, log, agent, orchestrator, types, onlyJob };
}
