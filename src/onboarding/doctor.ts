import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { FactoryConfig } from "../config/types.js";
import { AppAuth, githubAuthFromKeychain, GITHUB_SECRETS, type GitHubAuth } from "../github/auth.js";
import { GitHubClient, type Fetch } from "../github/client.js";
import { homePaths } from "../home.js";
import type { Clones } from "../repos/clones.js";
import { checkSecretKey, type SecretStore } from "../secrets/keychain.js";
import { resolveSecretRef } from "../secrets/refs.js";
import type { CheckRunner, Sandbox } from "../stages/check-runner.js";
import { openSqliteJobStore } from "../store/sqlite-job-store.js";
import { baselineCheck } from "./baseline.js";
import { GITLEAKS_VERSION, gitleaksVersion } from "./gitleaks.js";

/** One self-check: by name, what it found, and if it failed, how to fix it. */
export interface SelfCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  home: string;
  secrets: SecretStore;
  /** The agent's Sandbox (the SDK's) and the Check Stages' (`sandbox-runtime`). */
  sandboxes: { agent: Sandbox; check: Sandbox };
  fetch?: Fetch;
  githubBaseUrl?: string;
  /** Whether a Claude subscription login is on this machine, for subscription sign-in. */
  subscriptionLogin?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Only `--baseline` needs these. */
  baseline?: { clones: Clones; checks: CheckRunner };
}

/** The App's permissions on each installation (ADR 0011): contents, PRs and issues to write; checks and metadata to read. */
export const APP_PERMISSIONS: Record<string, "read" | "write"> = { contents: "write", pull_requests: "write", issues: "write", checks: "read", metadata: "read" };

/**
 * The self-checks (ADR 0011) that `factory doctor` prints and every `factory run` start requires:
 * both sandboxes, the keychain, GitHub credentials and each installation's permissions, gitleaks
 * at its pin, the Job store writable, the config check, and agent sign-in matching the configured
 * mode. `baseline` adds each Target repo's Baseline check. Never throws: a broken check is a failed one.
 */
export async function selfChecks(deps: DoctorDeps, { baseline = false } = {}): Promise<SelfCheck[]> {
  const out: SelfCheck[] = [];
  const check = async (name: string, fix: string, run: () => Promise<string>) => {
    try {
      out.push({ name, ok: true, detail: await run() });
    } catch (err) {
      out.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), fix });
    }
  };
  const paths = homePaths(deps.home);

  let config: FactoryConfig | null = null;
  await check("config", "Fix the problems listed, then run `factory config check`.", async () => {
    if (!existsSync(paths.config)) throw new Error(`No config at ${paths.config}.`);
    const loaded = loadConfig(readFileSync(paths.config, "utf8"));
    if (!loaded.ok) throw new Error(`factory.yaml fails the config check: ${loaded.problems.join(" ")}`);
    config = loaded.config;
    return `${paths.config} passes (${loaded.config.repos.length} Target repo${loaded.config.repos.length === 1 ? "" : "s"}).`;
  });
  if (!existsSync(paths.config)) out[out.length - 1]!.fix = "Run `factory init`.";

  const sandboxFix = process.platform === "linux" ? "Install bubblewrap and socat: `sudo apt-get install bubblewrap socat` (or your distribution's equivalent)." : "Stage runs need the OS Sandbox; see the message above.";
  await check("agent-sandbox", sandboxFix, async () => (await deps.sandboxes.agent.ready(), "Agent sessions can be sandboxed."));
  await check("check-sandbox", sandboxFix, async () => (await deps.sandboxes.check.ready(), "Check Stage commands can be sandboxed."));

  await check("keychain", "Unlock your login keychain (macOS) or start a Secret Service such as gnome-keyring (Linux).", async () => {
    await deps.secrets.get(GITHUB_SECRETS.appId);
    return "The keychain can be read.";
  });

  let auth: GitHubAuth | null = null;
  await check("github", "Run `factory init` (or `factory init --token`).", async () => {
    auth = await githubAuthFromKeychain(deps.secrets, deps.fetch);
    return auth instanceof AppAuth ? "Signed in as the Factory's GitHub App." : "Signed in with a personal token (the --token fallback).";
  });
  // Assigned inside the check above, which TypeScript can't see.
  const signedIn = auth as GitHubAuth | null;
  if (signedIn) {
    const client = new GitHubClient({ auth: signedIn, ...(deps.fetch && { fetch: deps.fetch }), ...(deps.githubBaseUrl && { baseUrl: deps.githubBaseUrl }), sleep: async () => {} });
    for (const repo of (config as FactoryConfig | null)?.repos ?? []) {
      const name = repo.name;
      if (signedIn instanceof AppAuth) {
        await check(`github:${name}`, `Install the Factory's GitHub App on ${name} with the permissions it asks for (Settings → GitHub Apps → Configure), and accept any permission update.`, async () => {
          const found = await client.request<{ permissions?: Record<string, string> }>("GET", `/repos/${name}/installation`);
          if (found.status === 404) throw new Error(`The App isn't installed on ${name}.`);
          const missing = Object.entries(APP_PERMISSIONS).filter(([p, level]) => {
            const has = found.body?.permissions?.[p];
            return level === "write" ? has !== "write" : has !== "read" && has !== "write";
          });
          if (missing.length) throw new Error(`The installation on ${name} lacks ${missing.map(([p, l]) => `${p}: ${l}`).join(", ")}.`);
          await signedIn.token(name);
          return `The App can act on ${name} (installation token minted).`;
        });
      } else {
        await check(`github:${name}`, `Use a token with write access to ${name}'s contents, pull requests and issues.`, async () => {
          const found = await client.request<{ permissions?: { push?: boolean } }>("GET", `/repos/${name}`, { repo: name });
          if (found.status === 404) throw new Error(`The token can't see ${name}.`);
          if (!found.body?.permissions?.push) throw new Error(`The token has no write access to ${name}.`);
          return `The token can write to ${name}.`;
        });
      }
    }
  }

  await check("gitleaks", "Run `factory init` to install the pinned gitleaks.", async () => {
    if (!existsSync(paths.gitleaks)) throw new Error(`gitleaks isn't at ${paths.gitleaks}.`);
    const version = await gitleaksVersion(paths.gitleaks);
    if (version !== GITLEAKS_VERSION) throw new Error(`gitleaks is ${version}, but the Factory pins ${GITLEAKS_VERSION}.`);
    return `gitleaks ${version}.`;
  });

  await check("job-store", `Make ${deps.home} writable by you.`, async () => {
    const store = openSqliteJobStore(paths.jobStore);
    try {
      store.transaction(() => {
        store.saveCursor("doctor", new Date().toISOString());
        store.saveCursor("doctor", null);
      });
    } finally {
      store.close();
    }
    return `${paths.jobStore} is writable.`;
  });

  const signIn = (config as FactoryConfig | null)?.agent;
  if (signIn) {
    if (signIn.auth === "api-key") {
      await check("sign-in", "Set agent.api_key to keychain:NAME (store the key with `factory secret set`) or ${env:NAME}, or switch agent.auth to subscription.", async () => {
        if (!signIn.api_key) throw new Error("API-key sign-in is configured, but agent.api_key is not set.");
        if (!(await resolveSecretRef(signIn.api_key, deps.secrets, deps.env))) throw new Error(`API-key sign-in is configured, but ${signIn.api_key} is empty.`);
        return "API-key sign-in, with a key.";
      });
    } else {
      await check("sign-in", "Sign in to Claude Code with your subscription (run `claude` and `/login`), or switch agent.auth to api-key.", async () => {
        if (!(await (deps.subscriptionLogin ?? hasSubscriptionLogin)())) throw new Error("Subscription sign-in is configured, but no Claude login is on this machine.");
        return "Subscription sign-in, with a Claude login.";
      });
    }
  }

  if (baseline && deps.baseline) {
    for (const repo of (config as FactoryConfig | null)?.repos ?? []) {
      await check(`baseline:${repo.name}`, `Fix ${repo.name}'s default branch so its Check Stages pass: every Job there would fail.`, async () => {
        const secrets: Record<string, string> = {};
        for (const name of repo.check_secrets ?? []) {
          const value = await deps.secrets.get(checkSecretKey(repo.name, name));
          if (value === null) throw new Error(`Check secret ${name} isn't in the keychain (\`factory secret set ${repo.name} ${name}\`).`);
          secrets[name] = value;
        }
        const result = await baselineCheck(deps.baseline!.clones, deps.baseline!.checks, { repo: repo.name, checks: checksOf(config!, repo.name), network: repo.network ?? [], secrets });
        if (!result.passed) throw new Error(`Check Stage "${result.check}": \`${result.command}\` exited ${result.exit_code} on ${result.head.slice(0, 7)}.`);
        return `Green on ${result.head.slice(0, 7)}.`;
      });
    }
  }
  return out;
}

/** The Check Stages a repo's default Pipeline runs, with the commands each runs there. */
function checksOf(config: FactoryConfig, name: string): Record<string, string[]> {
  const repo = config.repos.find((r) => r.name === name)!;
  const out: Record<string, string[]> = {};
  for (const id of config.pipelines[repo.default_pipeline]?.stages ?? []) {
    const stage = config.stages[id];
    if (stage?.kind === "check") out[id] = repo.commands?.[stage.run] ?? [];
  }
  return out;
}

/** The self-checks as `factory doctor` prints them: one line each, and a fix under each failure. */
export function renderSelfChecks(checks: SelfCheck[]): string {
  return checks.map((c) => (c.ok ? `ok    ${c.name}: ${c.detail}\n` : `FAIL  ${c.name}: ${c.detail}\n      fix: ${c.fix}\n`)).join("");
}

/** Claude Code keeps a subscription login in the macOS keychain, or in `~/.claude/.credentials.json` elsewhere. */
async function hasSubscriptionLogin(): Promise<boolean> {
  if (process.platform !== "darwin") return existsSync(join(homedir(), ".claude", ".credentials.json"));
  return new Promise((resolve) => execFile("security", ["find-generic-password", "-s", "Claude Code-credentials"], (err) => resolve(!err)));
}
