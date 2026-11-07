import { SourceCredentialsRefused } from "../source/source.js";
import type { GitHubAuth } from "./auth.js";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export interface GitHubResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Null for a 304 or an empty body. */
  body: T | null;
}

/** GitHub couldn't be reached or kept failing after its transient retries (ADR 0010). */
export class GitHubUnavailable extends Error {
  override name = "GitHubUnavailable";
}

/** GitHub refused the Factory's credentials: a Factory fault, not something to retry (ADR 0010). */
export class GitHubAuthError extends SourceCredentialsRefused {
  override name = "GitHubAuthError";
}

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * GitHub refused a call in a way waiting won't fix: a permission the Factory's App lacks (403), or a
 * repo it can't see (404). A Factory fault, not an outage (ADR 0010).
 */
export class GitHubRefused extends Error {
  override name = "GitHubRefused";
  constructor(
    readonly status: number,
    /** The call refused, as "METHOD /path". */
    readonly call: string,
    /** The permissions GitHub said the call needs (`x-accepted-github-permissions`), if it said. */
    readonly permissions: string | null,
    /** What GitHub said about it, or what its status means when it said nothing. */
    readonly detail: string | null,
  ) {
    super(`${call} → ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export interface GitHubClientOptions {
  auth: GitHubAuth;
  fetch?: Fetch;
  baseUrl?: string;
  /** Waits between transient retries. */
  sleep?: (ms: number) => Promise<void>;
}

/** Three tries over about five minutes (ADR 0010). */
const BACKOFF_MS = [30_000, 90_000, 180_000];
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * GitHub's REST API as the Factory uses it: authenticated per repo (as the App's installation,
 * or a personal token), transient failures retried with backoff, and the rate limit tracked from
 * responses. A 304 doesn't count toward GitHub's rate limit, so it doesn't count here either.
 */
export class GitHubClient {
  /** Requests left in the current rate-limit window, as GitHub last reported. */
  rateLimitRemaining: number | null = null;
  private readonly fetch: Fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
  }

  /**
   * One request for `repo` (whose installation token signs it). `etag` makes it conditional.
   * Throws GitHubAuthError on 401, GitHubUnavailable once transient retries run out (a rate-limited
   * 403 among them), GitHubRefused on any other 403, and GitHubError for any other failure; a 304
   * and a 404 come back as they are.
   */
  async request<T>(method: string, path: string, opts: { repo?: string; etag?: string; body?: unknown } = {}): Promise<GitHubResponse<T>> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    for (let i = 0; ; i++) {
      let response: Response;
      try {
        const token = await this.options.auth.token(opts.repo ?? null);
        response = await this.fetch(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "software-factory",
            authorization: `Bearer ${token}`,
            ...(opts.etag && { "if-none-match": opts.etag }),
            ...(opts.body !== undefined && { "content-type": "application/json" }),
          },
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        });
      } catch (err) {
        if (err instanceof GitHubAuthError) throw err;
        if (i < BACKOFF_MS.length) {
          await (this.options.sleep ?? sleep)(BACKOFF_MS[i]!);
          continue;
        }
        throw new GitHubUnavailable(`GitHub can't be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (response.status !== 304) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining !== null) this.rateLimitRemaining = Number(remaining);
      }
      if (response.status === 304) return { status: 304, headers: response.headers, body: null };
      if (response.status === 401) throw new GitHubAuthError(`GitHub refused the Factory's credentials (${method} ${path}).`);
      const text = response.status >= 400 ? await response.text() : null;
      // A rate-limited 403, primary or secondary, is transient too.
      const limited = response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") || /rate limit/i.test(text ?? ""));
      if (TRANSIENT.has(response.status) || limited) {
        if (i < BACKOFF_MS.length) {
          await (this.options.sleep ?? sleep)(BACKOFF_MS[i]!);
          continue;
        }
        throw new GitHubUnavailable(`GitHub kept failing: ${method} ${path} → ${response.status}.`);
      }
      if (response.status === 403) throw new GitHubRefused(403, `${method} ${path}`, response.headers.get("x-accepted-github-permissions"), messageOf(text));
      const raw = text ?? (await response.text());
      const body = raw ? (JSON.parse(raw) as T) : null;
      if (response.status >= 400 && response.status !== 404) throw new GitHubError(response.status, `${method} ${path} → ${response.status}: ${raw.slice(0, 300)}`);
      return { status: response.status, headers: response.headers, body };
    }
  }

  /** Every page of a list, following `Link: rel="next"`. */
  async all<T>(path: string, opts: { repo?: string } = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    while (next) {
      const page: GitHubResponse<T[]> = await this.request<T[]>("GET", next, opts);
      out.push(...(page.body ?? []));
      next = nextLink(page.headers.get("link"));
    }
    return out;
  }
}

export function nextLink(link: string | null): string | null {
  const match = link?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/);
  return match?.[1] ?? null;
}

/** GitHub's `message` from an error body, or the body itself, kept short. */
function messageOf(text: string | null): string | null {
  if (!text) return null;
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {
    // Not JSON: the text is the message.
  }
  return text.slice(0, 300);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
