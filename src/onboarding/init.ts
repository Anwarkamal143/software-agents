import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { AppAuth, GITHUB_SECRETS, TokenAuth, type GitHubAuth } from "../github/auth.js";
import { GitHubClient, type Fetch } from "../github/client.js";
import { homePaths } from "../home.js";
import type { WritableSecretStore } from "../secrets/keychain.js";
import { starterConfig } from "./config-edit.js";
import { GITLEAKS_VERSION, installGitleaks } from "./gitleaks.js";
import type { AppCredentials } from "./manifest.js";

export interface InitOptions {
  /** The personal-token fallback: read a token from stdin instead of creating an App. */
  token?: boolean;
}

export interface InitDeps {
  home: string;
  secrets: WritableSecretStore;
  out: (s: string) => void;
  /** Creates the App through GitHub's manifest flow. */
  manifestFlow: () => Promise<AppCredentials>;
  /** Reads the personal token, for `--token`. */
  readToken: () => Promise<string>;
  /** Installs the pinned gitleaks at `dest`; true if it downloaded. */
  installGitleaks?: (dest: string) => Promise<boolean>;
  /** GitHub's API, to check a token and find who owns the credentials. */
  fetch?: Fetch;
  githubBaseUrl?: string;
  platform?: NodeJS.Platform;
  /** Whether a command is on PATH. */
  hasCommand?: (name: string) => Promise<boolean>;
}

/**
 * `factory init` (ADR 0011), once per machine: the Factory home; the Factory's own GitHub App
 * through the manifest flow, its id and key straight into the keychain (or with `--token`, a
 * personal token); a starter `factory.yaml` with you as the one allowed human; and the pinned
 * gitleaks. On Linux it checks for bubblewrap. Running it again keeps what's already there.
 */
export async function factoryInit(options: InitOptions, deps: InitDeps): Promise<void> {
  const paths = homePaths(deps.home);
  mkdirSync(deps.home, { recursive: true, mode: 0o700 });
  chmodSync(deps.home, 0o700);

  if ((deps.platform ?? process.platform) === "linux") {
    const has = deps.hasCommand ?? onPath;
    const absent: string[] = [];
    for (const [cmd, pkg] of [["bwrap", "bubblewrap"], ["socat", "socat"]] as const) if (!(await has(cmd))) absent.push(pkg);
    if (absent.length) deps.out(`The Sandbox needs ${absent.join(" and ")}, which isn't installed. Install with:\n  sudo apt-get install ${absent.join(" ")}\n(or your distribution's package manager). No Stage runs until it is.\n`);
  }

  const login = await credentials(options, deps);

  if (existsSync(paths.config)) deps.out(`Keeping the existing ${paths.config}.\n`);
  else {
    writeFileSync(paths.config, starterConfig(login), { mode: 0o600 });
    deps.out(`Wrote ${paths.config} with ${login} as the one person allowed to approve Jobs.\n`);
  }

  const installed = await (deps.installGitleaks ?? ((dest: string) => installGitleaks(dest)))(paths.gitleaks);
  deps.out(installed ? `Installed gitleaks ${GITLEAKS_VERSION} (checksum verified) at ${paths.gitleaks}.\n` : `gitleaks ${GITLEAKS_VERSION} is already installed.\n`);

  deps.out(`\nNext: \`factory repo add <owner/repo>\` for each Target repo, then \`factory doctor\`.\n`);
}

/** Puts GitHub credentials in the keychain unless they're there already. Returns the GitHub login that owns them. */
async function credentials(options: InitOptions, deps: InitDeps): Promise<string> {
  const [appId, privateKey, existingToken] = await Promise.all([deps.secrets.get(GITHUB_SECRETS.appId), deps.secrets.get(GITHUB_SECRETS.privateKey), deps.secrets.get(GITHUB_SECRETS.token)]);
  const api = (auth: GitHubAuth) => new GitHubClient({ auth, ...(deps.fetch && { fetch: deps.fetch }), ...(deps.githubBaseUrl && { baseUrl: deps.githubBaseUrl }), sleep: async () => {} });
  const tokenOwner = async (token: string) => {
    const me = await api(new TokenAuth(token)).request<{ login?: string }>("GET", "/user");
    if (me.status !== 200 || !me.body?.login) throw new Error("GitHub doesn't accept that token.");
    return me.body.login;
  };

  if (options.token) {
    deps.out("Paste a GitHub personal token with read and write access to contents, pull requests and issues, then press Enter and Ctrl-D:\n");
    const token = (await deps.readToken()).trim();
    if (!token) throw new Error("No token given.");
    const login = await tokenOwner(token);
    await deps.secrets.set(GITHUB_SECRETS.token, token);
    deps.out(`Stored the token for ${login} in the keychain.\n`);
    return login;
  }
  if (appId && privateKey) {
    deps.out("The Factory's GitHub App is already in the keychain.\n");
    const app = await api(new AppAuth({ appId, privateKey, ...(deps.fetch && { fetch: deps.fetch }) })).request<{ owner?: { login: string } }>("GET", "/app");
    if (app.status !== 200 || !app.body?.owner) throw new Error("The GitHub App in the keychain isn't accepted by GitHub: run `factory init --token`, or remove it from the keychain and run `factory init` again.");
    return app.body.owner.login;
  }
  if (existingToken) {
    deps.out("A personal token is already in the keychain; run `factory init --token` to replace it.\n");
    return tokenOwner(existingToken);
  }
  const app = await deps.manifestFlow();
  await deps.secrets.set(GITHUB_SECRETS.appId, app.appId);
  await deps.secrets.set(GITHUB_SECRETS.privateKey, app.privateKey);
  deps.out(`Created the GitHub App ${app.slug} and stored its id and private key in the keychain.\nInstall it on your Target repos: https://github.com/apps/${app.slug}/installations/new\n`);
  return app.owner;
}

function onPath(name: string): Promise<boolean> {
  return new Promise((resolve) => execFile("sh", ["-c", `command -v ${name}`], (err) => resolve(!err)));
}
