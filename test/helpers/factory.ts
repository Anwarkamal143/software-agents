import { expect } from "vitest";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import type { FactoryEvent } from "../../src/events/envelope.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigHolder } from "../../src/config/holder.js";
import { EventLog } from "../../src/jobs/event-log.js";
import { Orchestrator, type OrchestratorDeps } from "../../src/orchestrator/orchestrator.js";
import type { JobStore } from "../../src/store/job-store.js";
import { PrePushChecks } from "../../src/repos/prepush.js";
import { Clones } from "../../src/repos/clones.js";
import { SandboxedCheckRunner, srtSandbox, type Sandbox } from "../../src/stages/check-runner.js";
import { ArtifactStore } from "../../src/store/artifact-store.js";
import { openSqliteJobStore } from "../../src/store/sqlite-job-store.js";
import { ScriptedAgent } from "../fakes/agent.js";
import { FakeMirror } from "../fakes/mirror.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { FakePullRequests } from "../fakes/pulls.js";
import { FakeSecrets } from "../fakes/secrets.js";
import { FakeSource } from "../fakes/source.js";
import { fixture } from "./config.js";
import { makeRemote } from "./git.js";
import { gitleaksPath } from "./gitleaks.js";
import { tmpHome } from "./tmp.js";

/** A whole Factory on fakes: real Event log, config and sandboxed Check Stages; scripted agent, fake Source, Mirror and keychain. */
export interface FakeFactoryOptions {
  secrets?: FakeSecrets;
  /** The Sandbox Check Stage commands run under, and the self-check asks about. Default the real one. */
  sandbox?: Sandbox;
  /** The Sandbox the self-check asks about for agent sessions. Default the real one. */
  agentSandbox?: Sandbox;
  /** What the self-check asks about for Check Stages, when it isn't the Sandbox they run under. */
  checkSandboxSelfCheck?: Sandbox;
  now?: () => Date;
  /** Wraps the Job store the Orchestrator writes to, such as to make it fail. */
  wrapStore?: (store: JobStore) => JobStore;
  limits?: OrchestratorDeps["limits"];
  /** GitHub's PRs to carry over, as across a restart: GitHub keeps them while the Factory is down. */
  pulls?: FakePullRequests;
  /** Replaces waiting between transient retries; records how long it would have waited. */
  sleeps?: number[];
}

export function fakeFactory(agent = new ScriptedAgent(), configText = fixture("e2e.yaml"), opts: FakeFactoryOptions = {}) {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), configText);
  const remote = makeRemote(join(home, "github"));
  return factoryAt(home, remote, agent, opts);
}

/**
 * A Factory on an existing home and remote: another Orchestrator over the same Job store,
 * as after a restart. The previous one is simply never called again.
 */
export function factoryAt<A extends AgentAdapter = ScriptedAgent>(home: string, remote: string, agent: A = new ScriptedAgent() as unknown as A, opts: FakeFactoryOptions = {}) {
  const clones = new Clones(home, { remoteUrl: () => remote });
  const source = new FakeSource();
  const mirror = new FakeMirror();
  const artifacts = new ArtifactStore(home);
  const secrets = opts.secrets ?? new FakeSecrets();
  const notifier = new FakeNotifier();
  const pulls = opts.pulls ?? new FakePullRequests(remote);
  const store = openSqliteJobStore(join(home, "factory.db"));
  const log = new EventLog(opts.wrapStore ? opts.wrapStore(store) : store);
  const orchestrator = new Orchestrator({
    log,
    config: ConfigHolder.open(join(home, "factory.yaml")),
    source,
    agent,
    checks: new SandboxedCheckRunner({ factoryHome: home, ...(opts.sandbox && { sandbox: opts.sandbox }) }),
    sandboxes: { agent: opts.agentSandbox ?? srtSandbox, check: opts.checkSandboxSelfCheck ?? opts.sandbox ?? srtSandbox },
    secrets,
    mirrors: [mirror],
    pulls,
    artifacts,
    clones,
    prePush: new PrePushChecks(home, { gitleaks: gitleaksPath() }),
    notifier,
    ...(opts.now && { now: opts.now }),
    ...(opts.limits && { limits: opts.limits }),
    sleep: async (ms: number) => void opts.sleeps?.push(ms),
  });
  /** Event types for one Job, in order. */
  const types = (job_id: string) => log.store.read().filter((e) => e.job_id === job_id).map((e) => e.type);
  const onlyJob = () => {
    const [job, ...rest] = log.jobs();
    if (!job || rest.length) throw new Error(`expected one Job, found ${log.jobs().length}`);
    return job;
  };
  return { home, remote, clones, source, mirror, pulls, notifier, log, agent, artifacts, secrets, orchestrator, types, onlyJob };
}

/**
 * The Job came through its Pipeline to the Merge gate, which passed and asked a human: the e2e
 * config leaves Autonomy at trial, where you merge or `/approve`.
 */
export function expectAtMergeGate(events: FactoryEvent[], over: Record<string, unknown> = {}): void {
  expect(events.at(-2)).toMatchObject({ type: "checkpoint-evaluated", data: { checkpoint: "merge-gate", outcome: "ask" }, ...over });
  expect(events.at(-1)).toMatchObject({ type: "human-requested", data: { kind: "approval", cause: "autonomy" }, ...over });
}
