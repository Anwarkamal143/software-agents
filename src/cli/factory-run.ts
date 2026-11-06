import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter, FACTORY_PLUGIN_DIR } from "../agents/claude.js";
import { ConfigHolder } from "../config/holder.js";
import { githubAuthFromKeychain, GITHUB_SECRETS } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { homePaths } from "../home.js";
import { housekeep } from "../housekeeping/housekeeping.js";
import { OsNotifier } from "../humans/notify.js";
import { EventLog } from "../jobs/event-log.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { runFactory } from "../orchestrator/runner.js";
import { Clones } from "../repos/clones.js";
import { PrePushChecks } from "../repos/prepush.js";
import { OsKeychain, type SecretStore } from "../secrets/keychain.js";
import { GitHubSource } from "../source/github.js";
import { SandboxedCheckRunner } from "../stages/check-runner.js";
import { ArtifactStore } from "../store/artifact-store.js";
import { openSqliteJobStore } from "../store/sqlite-job-store.js";

/** Where `factory init` pins gitleaks in the Factory home (ADR 0011). */
const GITLEAKS = (home: string) => join(home, "tools", "gitleaks");

/**
 * `factory run`: the foreground Orchestrator, wired to the real Job store, keychain, GitHub
 * Source, Claude adapter, Sandbox and Trusted clones. Runs until `signal` aborts.
 */
export async function factoryRun(home: string, signal: AbortSignal, report: (s: string) => void, secrets: SecretStore = new OsKeychain()): Promise<void> {
  const paths = homePaths(home);
  if (!existsSync(paths.config)) throw new Error(`No config at ${paths.config}: run \`factory init\` first.`);
  const config = ConfigHolder.open(paths.config);
  const store = openSqliteJobStore(paths.jobStore);
  try {
    const log = new EventLog(store);
    const client = new GitHubClient({ auth: await githubAuthFromKeychain(secrets) });
    const source = new GitHubSource({
      client,
      config: () => ({ repos: config.current.repos.map((r) => r.name), humans: config.current.humans, readyLabel: config.current.sources[0]?.ready_label ?? "factory:ready" }),
    });
    const apiKey = () => credential(config.current.agent.api_key, secrets);
    const agent = new ClaudeAdapter({
      home,
      signIn: config.current.agent.auth,
      apiKey,
      pluginDir: FACTORY_PLUGIN_DIR,
      // Exact values never to write to a Transcript: every Factory credential and check secret (ADR 0009).
      secrets: async () => {
        const names = [...Object.values(GITHUB_SECRETS), ...config.current.repos.flatMap((r) => r.check_secrets ?? [])];
        const out: Record<string, string> = {};
        for (const name of names) {
          const value = await secrets.get(name).catch(() => null);
          if (value) out[name] = value;
        }
        const key = await apiKey();
        if (key) out.ANTHROPIC_API_KEY = key;
        return out;
      },
    });
    const clones = new Clones(home, { remoteUrl: (repo) => `https://github.com/${repo}.git` });
    const artifacts = new ArtifactStore(home);
    const orchestrator = new Orchestrator({
      log,
      config,
      source,
      agent,
      checks: new SandboxedCheckRunner({ factoryHome: home }),
      mirrors: [],
      artifacts,
      clones,
      prePush: new PrePushChecks(home, { gitleaks: GITLEAKS(home) }),
      secrets,
      notifier: new OsNotifier(),
    });
    report(`The Factory is running from ${home}. Ctrl-C stops it; unfinished Stage runs resume at the next start.\n`);
    await runFactory({ home, loop: orchestrator, housekeeping: () => housekeep({ home, log, artifacts, branches: clones }), signal, report: (m) => report(`${m}\n`) });
    log.record({ type: "factory-stopped", actor: "orchestrator" });
  } finally {
    store.close();
  }
}

/** A `${env:NAME}` or `keychain:NAME` reference, resolved; null if unset. */
async function credential(ref: string | undefined, secrets: SecretStore): Promise<string | null> {
  if (!ref) return null;
  const env = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
  if (env) return process.env[env[1]!] ?? null;
  if (ref.startsWith("keychain:")) return secrets.get(ref.slice("keychain:".length));
  return null;
}
