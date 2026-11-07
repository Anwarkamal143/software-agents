import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { APP_PERMISSIONS } from "./doctor.js";

/** What GitHub hands back for the App the manifest created. */
export interface AppCredentials {
  appId: string;
  privateKey: string;
  slug: string;
  /** The account that owns the App: you, or your organization. */
  owner: string;
  htmlUrl: string;
}

/**
 * The App manifest (ADR 0011): a private App with exactly the permissions the Factory needs and
 * no webhooks, whose one redirect is the local callback.
 */
export function appManifest(callbackUrl: string, name: string) {
  return {
    name,
    url: "https://github.com/Anwarkamal143/software-agents",
    redirect_url: callbackUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

export interface ManifestFlowOptions {
  /** Opens a URL in your browser; the URL is printed as well. */
  open: (url: string) => void;
  out: (s: string) => void;
  /** Fetch for GitHub's API, which turns the callback's code into the App's credentials. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;
  /** Where to create the App: your account by default, or an organization's. */
  org?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  timeoutMs?: number;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * GitHub's App manifest flow, run once: a page on `127.0.0.1` posts the manifest to GitHub, you
 * click "Create", and GitHub redirects back to the page's callback with a one-time code, which is
 * exchanged for the App id and private key. They come back to the caller, which puts them straight
 * in the keychain; nothing is written to disk. Only the callback carrying this run's own `state` counts.
 */
export async function manifestFlow(options: ManifestFlowOptions): Promise<AppCredentials> {
  const state = randomBytes(16).toString("hex");
  const name = `software-factory-${randomBytes(3).toString("hex")}`;
  const web = options.webBaseUrl ?? "https://github.com";
  const api = options.apiBaseUrl ?? "https://api.github.com";
  const action = `${web}${options.org ? `/organizations/${encodeURIComponent(options.org)}` : ""}/settings/apps/new?state=${state}`;
  const fetchFn = options.fetch ?? ((u, i) => fetch(u, i));

  let settle!: { resolve: (c: AppCredentials) => void; reject: (e: Error) => void };
  const done = new Promise<AppCredentials>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.pathname === "/") {
      const manifest = JSON.stringify(appManifest(`${base}/callback`, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Create the Factory's GitHub App</title>` +
          `<form id="f" method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(manifest)}">` +
          `<p>Creating your Software Factory GitHub App on GitHub…</p><button>Continue to GitHub</button></form>` +
          `<script>document.getElementById("f").submit()</script>`,
      );
      return;
    }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code || !/^[A-Za-z0-9_-]+$/.test(code)) {
        res.writeHead(400, { "content-type": "text/plain" }).end("This isn't the callback this `factory init` is waiting for.");
        return;
      }
      void fetchFn(`${api}/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "software-factory" } })
        .then(async (r) => {
          if (!r.ok) throw new Error(`GitHub refused the manifest code: ${r.status}.`);
          const app = (await r.json()) as { id: number; slug: string; pem: string; html_url: string; owner?: { login: string } };
          res.writeHead(200, { "content-type": "text/plain" }).end("The Factory's GitHub App is created. You can close this tab and go back to the terminal.");
          settle.resolve({ appId: String(app.id), privateKey: app.pem, slug: app.slug, owner: app.owner?.login ?? "", htmlUrl: app.html_url });
        })
        .catch((err: unknown) => {
          res.writeHead(502, { "content-type": "text/plain" }).end("Creating the App failed; see the terminal.");
          settle.reject(err instanceof Error ? err : new Error(String(err)));
        });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const start = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const timer = setTimeout(() => settle.reject(new Error("Gave up waiting for GitHub after 15 minutes. Run `factory init` again, or use `factory init --token`.")), options.timeoutMs ?? 15 * 60_000);
  options.out(`Opening ${start} to create the Factory's own GitHub App. If no browser opens, open that link yourself.\n`);
  options.open(start);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
