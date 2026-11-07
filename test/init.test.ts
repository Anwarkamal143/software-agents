import { describe, expect, test } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { GITHUB_SECRETS } from "../src/github/auth.js";
import { factoryInit, type InitDeps } from "../src/onboarding/init.js";
import { manifestFlow } from "../src/onboarding/manifest.js";
import { FakeGitHub } from "./fakes/github.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { tmpHome } from "./helpers/tmp.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function setup(over: Partial<InitDeps> = {}) {
  const home = join(tmpHome(), "factory-home");
  const secrets = new FakeSecrets();
  const gh = new FakeGitHub();
  let out = "";
  let flows = 0;
  const deps: InitDeps = {
    home,
    secrets,
    out: (s) => void (out += s),
    manifestFlow: async () => (flows++, { appId: "1001", privateKey: PEM, slug: "software-factory-abc123", owner: "alice", htmlUrl: "https://github.com/apps/software-factory-abc123" }),
    readToken: async () => "ghp_token\n",
    installGitleaks: async () => true,
    fetch: gh.fetch,
    platform: "darwin",
    ...over,
  };
  return { home, secrets, gh, deps, out: () => out, flows: () => flows };
}

describe("factory init", () => {
  test("creates the Factory home, the App's credentials in the keychain, a starter config and gitleaks", async () => {
    const s = setup();

    await factoryInit({}, s.deps);

    expect(statSync(s.home).mode & 0o777).toBe(0o700);
    expect(await s.secrets.get(GITHUB_SECRETS.appId)).toBe("1001");
    expect(await s.secrets.get(GITHUB_SECRETS.privateKey)).toBe(PEM);
    const config = readFileSync(join(s.home, "factory.yaml"), "utf8");
    expect(loadConfig(config)).toMatchObject({ ok: true, config: { humans: ["alice"] } });
    expect(config).not.toContain("BEGIN RSA");
    expect(s.out()).toContain("https://github.com/apps/software-factory-abc123/installations/new");
  });

  test("--token stores a personal token, checked against GitHub, instead of creating an App", async () => {
    const s = setup();
    s.gh.actingAs = { login: "bob", app: false };

    await factoryInit({ token: true }, s.deps);

    expect(s.flows()).toBe(0);
    expect(await s.secrets.get(GITHUB_SECRETS.token)).toBe("ghp_token");
    expect(loadConfig(readFileSync(join(s.home, "factory.yaml"), "utf8"))).toMatchObject({ ok: true, config: { humans: ["bob"] } });
  });

  test("running it again keeps the config and doesn't create a second App", async () => {
    const s = setup();
    await factoryInit({}, s.deps);
    writeFileSync(join(s.home, "factory.yaml"), readFileSync(join(s.home, "factory.yaml"), "utf8") + "# mine\n");
    s.deps.fetch = async (url) => (new URL(url).pathname === "/app" ? Response.json({ id: 1001, owner: { login: "alice" } }) : new Response("", { status: 404 }));

    await factoryInit({}, s.deps);

    expect(s.flows()).toBe(1);
    expect(readFileSync(join(s.home, "factory.yaml"), "utf8")).toContain("# mine");
  });

  test("on Linux without bubblewrap it prints the install command", async () => {
    const s = setup({ platform: "linux", hasCommand: async (c) => c !== "bwrap" });
    await factoryInit({}, s.deps);
    expect(s.out()).toContain("sudo apt-get install bubblewrap");
    expect(s.out()).not.toContain("install bubblewrap socat");
  });

  test("a gitleaks download that fails its checksum fails init", async () => {
    const s = setup({ installGitleaks: async () => Promise.reject(new Error("sha256 mismatch. Not installing.")) });
    await expect(factoryInit({}, s.deps)).rejects.toThrow(/Not installing/);
  });
});

describe("the GitHub App manifest flow", () => {
  test("posts a manifest with exactly the Factory's permissions and no webhooks, then exchanges the callback's code", async () => {
    const conversions: string[] = [];
    let page = "";
    const credentials = await manifestFlow({
      out: () => {},
      fetch: async (url, init) => {
        conversions.push(`${init.method} ${url}`);
        return Response.json({ id: 1001, slug: "software-factory-abc123", pem: PEM, html_url: "https://github.com/apps/software-factory-abc123", owner: { login: "alice" } }, { status: 201 });
      },
      open: (start) => {
        void (async () => {
          page = await (await fetch(start)).text();
          const state = /state=([0-9a-f]+)/.exec(page)![1];
          // Someone else's callback (wrong state) doesn't count.
          expect((await fetch(new URL(`/callback?code=evil&state=nope`, start))).status).toBe(400);
          await fetch(new URL(`/callback?code=abc123&state=${state}`, start));
        })();
      },
    });

    expect(credentials).toEqual({ appId: "1001", privateKey: PEM, slug: "software-factory-abc123", owner: "alice", htmlUrl: "https://github.com/apps/software-factory-abc123" });
    expect(conversions).toEqual(["POST https://api.github.com/app-manifests/abc123/conversions"]);
    expect(page).toContain('action="https://github.com/settings/apps/new?state=');
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page)![1]!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      public: false,
      default_permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
      default_events: [],
    });
    expect(manifest).not.toHaveProperty("hook_attributes");
    expect(String(manifest.redirect_url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });
});
