import { describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { GITHUB_SECRETS } from "../src/github/auth.js";
import type { Fetch } from "../src/github/client.js";
import { renderSelfChecks, selfChecks, type DoctorDeps } from "../src/onboarding/doctor.js";
import type { Sandbox } from "../src/stages/check-runner.js";
import { recorded } from "./fakes/github.js";
import { unavailableSandbox } from "./fakes/sandbox.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { fixture } from "./helpers/config.js";
import { gitleaksPath } from "./helpers/gitleaks.js";
import { nodeRemote } from "./fixtures/node-repo.js";
import { Clones } from "../src/repos/clones.js";
import { SandboxedCheckRunner } from "../src/stages/check-runner.js";
import { tmpHome } from "./helpers/tmp.js";

const ready: Sandbox = { ready: async () => {}, wrap: () => Promise.reject(new Error("unused")), close: async () => {} };
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const SUBSCRIPTION = fixture("minimal.yaml") + "agent: { auth: subscription }\n";

/** GitHub as the App sees it: installed on acme/web-app with `permissions`. */
function appGitHub(permissions: Record<string, string> | null): Fetch {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/repos/acme/web-app/installation") return permissions ? Response.json(recorded("installation", { permissions })) : Response.json({ message: "Not Found" }, { status: 404 });
    if (path.endsWith("/access_tokens")) return Response.json(recorded("access-token", { expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

function healthyHome(config = SUBSCRIPTION) {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), config);
  mkdirSync(join(home, "tools"));
  copyFileSync(gitleaksPath(), join(home, "tools", "gitleaks"));
  return home;
}

const deps = (home: string, over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  home,
  secrets: new FakeSecrets({ [GITHUB_SECRETS.appId]: "1001", [GITHUB_SECRETS.privateKey]: PRIVATE_KEY }),
  sandboxes: { agent: ready, check: ready },
  fetch: appGitHub(recorded<{ permissions: Record<string, string> }>("installation").permissions),
  subscriptionLogin: async () => true,
  ...over,
});

describe("factory doctor", () => {
  test("on a healthy machine every check passes", async () => {
    const checks = await selfChecks(deps(healthyHome()));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(["config", "agent-sandbox", "check-sandbox", "keychain", "github", "github:acme/web-app", "gitleaks", "job-store", "sign-in"]);
  });

  test("reports each failing check by name with a fix hint", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "factory.yaml"), fixture("minimal.yaml"));
    const checks = await selfChecks(
      deps(home, {
        sandboxes: { agent: unavailableSandbox(), check: unavailableSandbox() },
        fetch: appGitHub({ contents: "read", issues: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" }),
      }),
    );

    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toEqual(["agent-sandbox", "check-sandbox", "github:acme/web-app", "gitleaks", "sign-in"]);
    for (const c of failed) expect(c.fix, c.name).toMatch(/\w/);
    expect(failed.find((c) => c.name === "github:acme/web-app")!.detail).toBe("The installation on acme/web-app lacks contents: write.");
    expect(failed.find((c) => c.name === "sign-in")!.detail).toBe("API-key sign-in is configured, but agent.api_key is not set.");

    const text = renderSelfChecks(checks);
    expect(text).toContain("FAIL  gitleaks: gitleaks isn't at");
    expect(text).toMatch(/FAIL {2}gitleaks: .*\n {6}fix: Run `factory init` to install the pinned gitleaks\.\n/);
    expect(text).toContain("ok    keychain: The keychain can be read.\n");
  });

  test("with no config or credentials, says to run factory init", async () => {
    const checks = await selfChecks(deps(tmpHome(), { secrets: new FakeSecrets() }));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.config).toMatchObject({ ok: false, fix: "Run `factory init`." });
    expect(byName.github).toMatchObject({ ok: false, fix: "Run `factory init` (or `factory init --token`)." });
  });

  test("an App that can't read commit statuses fails, since the Merge gate reads them alongside check runs", async () => {
    const checks = await selfChecks(deps(healthyHome(), { fetch: appGitHub({ contents: "write", issues: "write", pull_requests: "write", checks: "read", metadata: "read" }) }));
    expect(checks.find((c) => c.name === "github:acme/web-app")).toMatchObject({ ok: false, detail: "The installation on acme/web-app lacks statuses: read." });
  });

  test("the App not installed on a repo, and a personal token without write access, fail by repo", async () => {
    const notInstalled = await selfChecks(deps(healthyHome(), { fetch: appGitHub(null) }));
    expect(notInstalled.find((c) => c.name === "github:acme/web-app")).toMatchObject({ ok: false, detail: "The App isn't installed on acme/web-app." });

    const token = await selfChecks(
      deps(healthyHome(), {
        secrets: new FakeSecrets({ [GITHUB_SECRETS.token]: "ghp_x" }),
        fetch: async () => Response.json({ full_name: "acme/web-app", permissions: { pull: true, push: false } }),
      }),
    );
    expect(token.find((c) => c.name === "github:acme/web-app")).toMatchObject({ ok: false, detail: "The token has no write access to acme/web-app." });
  });

  test("API-key sign-in needs its key", async () => {
    const config = fixture("minimal.yaml") + "agent: { auth: api-key, api_key: keychain:ANTHROPIC_API_KEY }\n";
    const without = await selfChecks(deps(healthyHome(config)));
    expect(without.find((c) => c.name === "sign-in")).toMatchObject({ ok: false, detail: "API-key sign-in is configured, but keychain:ANTHROPIC_API_KEY is empty." });
    const secrets = new FakeSecrets({ [GITHUB_SECRETS.appId]: "1001", [GITHUB_SECRETS.privateKey]: PRIVATE_KEY, ANTHROPIC_API_KEY: "sk-ant-x" });
    expect((await selfChecks(deps(healthyHome(config), { secrets }))).find((c) => c.name === "sign-in")).toMatchObject({ ok: true });
  });
});

describe("factory doctor --baseline", () => {
  test("adds each Target repo's Baseline check, red when its default branch fails", async () => {
    const config = SUBSCRIPTION.replace(/commands: \{ verify: \["npm test"\] \}/, 'commands: { verify: ["node --test"] }');
    const run = async (failingTest: boolean) => {
      const home = healthyHome(config);
      const remote = nodeRemote(join(home, "github"), { failingTest });
      return selfChecks(deps(home, { baseline: { clones: new Clones(home, { remoteUrl: () => remote }), checks: new SandboxedCheckRunner({ factoryHome: home }) } }), { baseline: true });
    };
    expect((await run(false)).find((c) => c.name === "baseline:acme/web-app")).toMatchObject({ ok: true });
    expect((await run(true)).find((c) => c.name === "baseline:acme/web-app")).toMatchObject({ ok: false, detail: expect.stringMatching(/^Check Stage "verify": `node --test` exited 1 on [0-9a-f]{7}\.$/) });
    // A check secret counts only under the repo's own keychain name.
    // A check secret counts only for the Check Stages that name it.
    const withSecret = config
      .replace("verify: { kind: check, run: verify }", "verify: { kind: check, run: verify, secrets: [DATABASE_URL] }")
      .replace('commands: { verify: ["node --test"] }', 'commands: { verify: ["node --test"] }\n    check_secrets: [DATABASE_URL]');
    const home = healthyHome(withSecret);
    const remote = nodeRemote(join(home, "github"));
    const baselineDeps = (secrets: Record<string, string>) =>
      deps(home, {
        secrets: new FakeSecrets({ [GITHUB_SECRETS.appId]: "1001", [GITHUB_SECRETS.privateKey]: PRIVATE_KEY, ...secrets }),
        baseline: { clones: new Clones(home, { remoteUrl: () => remote }), checks: new SandboxedCheckRunner({ factoryHome: home }) },
      });
    expect((await selfChecks(baselineDeps({ DATABASE_URL: "bare" }), { baseline: true })).find((c) => c.name === "baseline:acme/web-app")).toMatchObject({
      ok: false,
      detail: "Check secret DATABASE_URL isn't in the keychain (`factory secret set acme/web-app DATABASE_URL`).",
    });
    expect((await selfChecks(baselineDeps({ "check.acme.web-app.DATABASE_URL": "x" }), { baseline: true })).find((c) => c.name === "baseline:acme/web-app")).toMatchObject({ ok: true });
    // Without --baseline, no Baseline check.
    expect((await selfChecks(deps(healthyHome()))).some((c) => c.name.startsWith("baseline:"))).toBe(false);
  });
});
