import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { secretSet } from "../src/onboarding/secret-set.js";
import { FakeSecrets } from "./fakes/secrets.js";
import { fixture } from "./helpers/config.js";
import { tmpHome } from "./helpers/tmp.js";

const VALUE = "postgres://app:s3cret-0451@db/app";

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

function setup() {
  const home = tmpHome();
  writeFileSync(join(home, "factory.yaml"), fixture("minimal.yaml"));
  const secrets = new FakeSecrets();
  let out = "";
  return { home, secrets, out: () => out, deps: { home, secrets, out: (s: string) => void (out += s) } };
}

describe("factory secret set", () => {
  test("reads the value from stdin into the keychain; factory.yaml only names it", async () => {
    const s = setup();

    await secretSet("acme/web-app", "DATABASE_URL", async () => `${VALUE}\n`, s.deps);

    expect(await s.secrets.get("DATABASE_URL")).toBe(VALUE);
    const config = loadConfig(readFileSync(join(s.home, "factory.yaml"), "utf8"));
    expect(config).toMatchObject({ ok: true, config: { repos: [{ name: "acme/web-app", check_secrets: ["DATABASE_URL"] }] } });
    // Never on disk: not in factory.yaml, not anywhere in the Factory home.
    for (const file of filesUnder(s.home)) expect(readFileSync(file, "utf8"), file).not.toContain("s3cret-0451");
    expect(s.out()).not.toContain("s3cret-0451");
  });

  test("setting it again replaces the value and doesn't name it twice", async () => {
    const s = setup();
    await secretSet("acme/web-app", "DATABASE_URL", async () => "one", s.deps);
    await secretSet("acme/web-app", "DATABASE_URL", async () => "two", s.deps);
    expect(await s.secrets.get("DATABASE_URL")).toBe("two");
    expect(loadConfig(readFileSync(join(s.home, "factory.yaml"), "utf8"))).toMatchObject({ ok: true, config: { repos: [{ check_secrets: ["DATABASE_URL"] }] } });
  });

  test("refuses an empty value, a bad name, one of the Factory's own credentials, or a repo that isn't added", async () => {
    const s = setup();
    await expect(secretSet("acme/web-app", "DATABASE_URL", async () => "\n", s.deps)).rejects.toThrow(/empty/);
    await expect(secretSet("acme/web-app", "database-url", async () => "x", s.deps)).rejects.toThrow(/name/);
    await expect(secretSet("acme/other", "TOKEN", async () => "x", s.deps)).rejects.toThrow(/factory repo add acme\/other/);
    await expect(secretSet("acme/web-app", "GITHUB_TOKEN", async () => "x", s.deps)).rejects.toThrow(/the Factory's own credential/);
    await expect(secretSet("acme/web-app", "GITHUB_APP_PRIVATE_KEY", async () => "x", s.deps)).rejects.toThrow(/the Factory's own credential/);
    expect(s.secrets.read).toEqual([]);
  });
});
