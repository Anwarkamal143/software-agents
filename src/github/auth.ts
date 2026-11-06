import { createSign } from "node:crypto";
import type { SecretStore } from "../secrets/keychain.js";
import { GitHubAuthError, type Fetch } from "./client.js";

/** A token for GitHub requests about `repo` (null: not about one repo). Never handed to an agent (ADR 0007). */
export interface GitHubAuth {
  token(repo: string | null): Promise<string>;
}

/** Keychain names of the Factory's GitHub credentials, written by `factory init` (ADR 0011). */
export const GITHUB_SECRETS = { appId: "GITHUB_APP_ID", privateKey: "GITHUB_APP_PRIVATE_KEY", token: "GITHUB_TOKEN" } as const;

/** The personal-token fallback (`factory init --token`). */
export class TokenAuth implements GitHubAuth {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
}

/** Refresh an installation token this long before GitHub says it expires. */
const REFRESH_EARLY_MS = 5 * 60_000;

/**
 * The Factory's own GitHub App (ADR 0011): a JWT signed with the App's private key mints an
 * installation token per Target repo's installation, cached until shortly before it expires.
 */
export class AppAuth implements GitHubAuth {
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<number, { token: string; expires: number }>();

  constructor(
    private readonly options: { appId: string; privateKey: string; fetch?: Fetch; baseUrl?: string; now?: () => Date },
  ) {}

  async token(repo: string | null): Promise<string> {
    if (!repo) return this.jwt();
    const installation = await this.installation(repo);
    const cached = this.tokens.get(installation);
    if (cached && cached.expires - REFRESH_EARLY_MS > this.now()) return cached.token;
    const minted = await this.call<{ token: string; expires_at: string }>("POST", `/app/installations/${installation}/access_tokens`, `minting an installation token for ${repo}`);
    this.tokens.set(installation, { token: minted.token, expires: Date.parse(minted.expires_at) });
    return minted.token;
  }

  private async installation(repo: string): Promise<number> {
    const known = this.installations.get(repo);
    if (known !== undefined) return known;
    const found = await this.call<{ id: number }>("GET", `/repos/${repo}/installation`, `finding the App's installation on ${repo} (is the App installed there?)`);
    this.installations.set(repo, found.id);
    return found.id;
  }

  private async call<T>(method: string, path: string, what: string): Promise<T> {
    const response = await (this.options.fetch ?? ((u, i) => fetch(u, i)))(`${this.options.baseUrl ?? "https://api.github.com"}${path}`, {
      method,
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "software-factory", authorization: `Bearer ${this.jwt()}` },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new GitHubAuthError(`GitHub App auth failed ${what}: ${response.status}.`);
    }
    if (!response.ok) throw new Error(`GitHub App auth failed ${what}: ${response.status}.`);
    return (await response.json()) as T;
  }

  /** The App's JWT: RS256, issued a minute in the past for clock drift, valid nine minutes. */
  private jwt(): string {
    const now = Math.floor(this.now() / 1000);
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: this.options.appId })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.options.privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}

/** The App from the keychain, or the personal-token fallback. Throws if neither is there. */
export async function githubAuthFromKeychain(secrets: SecretStore, fetch?: Fetch): Promise<GitHubAuth> {
  const [appId, privateKey] = await Promise.all([secrets.get(GITHUB_SECRETS.appId), secrets.get(GITHUB_SECRETS.privateKey)]);
  if (appId && privateKey) return new AppAuth({ appId, privateKey, ...(fetch && { fetch }) });
  const token = await secrets.get(GITHUB_SECRETS.token);
  if (token) return new TokenAuth(token);
  throw new GitHubAuthError(`No GitHub credentials in the keychain: run \`factory init\` (or set ${GITHUB_SECRETS.token}).`);
}
