import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { addCheckSecret, addRepo, repoEntry, starterConfig } from "../src/onboarding/config-edit.js";

const problems = (text: string) => {
  const r = loadConfig(text);
  return r.ok ? [] : r.problems;
};

describe("the config onboarding writes", () => {
  test("the starter config from factory init passes the config check", () => {
    expect(problems(starterConfig("alice"))).toEqual([]);
    expect(loadConfig(starterConfig("alice"))).toMatchObject({ ok: true, config: { humans: ["alice"], repos: [], agent: { auth: "subscription" } } });
  });

  test("a repo with no Check Stages can't be added: its Pipeline could never pass the Merge gate", () => {
    const r = addRepo(starterConfig("alice"), repoEntry("acme/docs", { checks: {}, network: [] }));
    expect(r).toEqual({ ok: false, problems: ['Pipeline "acme/docs" has no Check Stage, so the Merge gate can never pass (no Evidence).'] });
  });

  test("the Check Stages a repo needs get its network and check secrets: new ones are made so, the starter's test is opened up", () => {
    const proposal = { checks: { test: ["npm ci", "npm test"], lint: ["npm ci", "npm run lint"] }, network: ["registry.npmjs.org"] };
    const added = addRepo(starterConfig("alice"), repoEntry("acme/web-app", proposal, ["NPM_TOKEN"]));
    if (!added.ok) throw new Error(added.problems.join("\n"));
    const loaded = loadConfig(added.text);
    expect(loaded).toMatchObject({
      ok: true,
      warnings: [],
      config: {
        stages: {
          test: { kind: "check", run: "test", on_fail: "build", network: true, secrets: ["NPM_TOKEN"] },
          lint: { kind: "check", run: "lint", on_fail: "build", network: true, secrets: ["NPM_TOKEN"] },
        },
      },
    });
  });

  test("an offline repo with no secrets leaves its Check Stages closed", () => {
    const added = addRepo(starterConfig("alice"), repoEntry("acme/web-app", { checks: { test: ["make test"] }, network: [] }));
    if (!added.ok) throw new Error(added.problems.join("\n"));
    expect(loadConfig(added.text)).toMatchObject({ ok: true, config: { stages: { test: { kind: "check", run: "test", on_fail: "build" } } } });
    expect(added.text).not.toMatch(/network: true|secrets:/);
  });

  test("a secret on a Check Stage another repo shares, without that secret, is refused: it would stop that repo's Jobs", () => {
    const first = addRepo(starterConfig("alice"), repoEntry("acme/web-app", { checks: { test: ["npm test"] }, network: [] }));
    if (!first.ok) throw new Error(first.problems.join("\n"));
    const second = addRepo(first.text, repoEntry("acme/api", { checks: { test: ["npm test"] }, network: [] }, ["DATABASE_URL"]));
    expect(second).toEqual({
      ok: false,
      problems: [
        'acme/api\'s check secret DATABASE_URL would go on Check Stage "test", which acme/web-app also runs without that secret. Give acme/api a Check Stage of its own: rename it in the pipeline and in commands.',
      ],
    });
  });

  test("opening a Check Stage another repo shares, which has hosts of its own, is refused: it would widen that repo's network", () => {
    const first = addRepo(starterConfig("alice"), repoEntry("acme/web-app", { checks: { test: ["make test"] }, network: [] }));
    if (!first.ok) throw new Error(first.problems.join("\n"));
    // acme/web-app has hosts, but its test Stage stays closed.
    const withHosts = first.text.replace("network: []", "network: [example.com]");
    expect(withHosts).not.toBe(first.text);
    const second = addRepo(withHosts, repoEntry("acme/api", { checks: { test: ["npm ci", "npm test"] }, network: ["registry.npmjs.org"] }));
    expect(second).toEqual({
      ok: false,
      problems: [
        'acme/api needs the network on Check Stage "test", which acme/web-app also runs with it closed. Give acme/api a Check Stage of its own: rename it in the pipeline and in commands.',
      ],
    });
  });

  test("a check secret's name is added to the repo once", () => {
    const added = addRepo(starterConfig("alice"), repoEntry("acme/web-app", { checks: { test: ["npm test"] }, network: [] }));
    if (!added.ok) throw new Error(added.problems.join("\n"));
    const twice = addCheckSecret(addCheckSecret(added.text, "acme/web-app", "DATABASE_URL"), "acme/web-app", "DATABASE_URL");
    expect(loadConfig(twice)).toMatchObject({ ok: true, config: { repos: [{ check_secrets: ["DATABASE_URL"] }] } });
    expect(() => addCheckSecret(added.text, "acme/other", "X")).toThrow(/factory repo add acme\/other/);
  });
});
