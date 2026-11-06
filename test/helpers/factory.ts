import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigHolder } from "../../src/config/holder.js";
import { EventLog } from "../../src/jobs/event-log.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { PrePushChecks } from "../../src/repos/prepush.js";
import { Clones } from "../../src/repos/clones.js";
import { SandboxedCheckRunner, type Sandbox } from "../../src/stages/check-runner.js";
import { ArtifactStore } from "../../src/store/artifact-store.js";
import { openSqliteJobStore } from "../../src/store/sqlite-job-store.js";
import { ScriptedAgent } from "../fakes/agent.js";
import { FakeMirror } from "../fakes/mirror.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { FakeSecrets } from "../fakes/secrets.js";
import { FakeSource } from "../fakes/source.js";
import { fixture } from "./config.js";
import { makeRemote } from "./git.js";
import { gitleaksPath } from "./gitleaks.js";
import { tmpHome } from "./tmp.js";

/** A whole Factory on fakes: real Event log, config and sandboxed Check Stages; scripted agent, fake Source, Mirror and keychain. */
export function fakeFactory(agent = new ScriptedAgent(), configText = fixture("e2e.yaml"), opts: { secrets?: FakeSecrets; sandbox?: Sandbox; now?: () => Date } = {}) {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), configText);
  const remote = makeRemote(join(home, "github"));
  const clones = new Clones(home, { remoteUrl: () => remote });
  const source = new FakeSource();
  const mirror = new FakeMirror();
  const artifacts = new ArtifactStore(home);
  const secrets = opts.secrets ?? new FakeSecrets();
  const notifier = new FakeNotifier();
  const log = new EventLog(openSqliteJobStore(join(home, "factory.db")));
  const orchestrator = new Orchestrator({
    log,
    config: ConfigHolder.open(join(home, "factory.yaml")),
    source,
    agent,
    checks: new SandboxedCheckRunner({ factoryHome: home, ...(opts.sandbox && { sandbox: opts.sandbox }) }),
    secrets,
    mirrors: [mirror],
    artifacts,
    clones,
    prePush: new PrePushChecks(home, { gitleaks: gitleaksPath() }),
    notifier,
    ...(opts.now && { now: opts.now }),
  });
  /** Event types for one Job, in order. */
  const types = (job_id: string) => log.store.read().filter((e) => e.job_id === job_id).map((e) => e.type);
  const onlyJob = () => {
    const [job, ...rest] = log.jobs();
    if (!job || rest.length) throw new Error(`expected one Job, found ${log.jobs().length}`);
    return job;
  };
  return { home, remote, clones, source, mirror, notifier, log, agent, artifacts, secrets, orchestrator, types, onlyJob };
}
