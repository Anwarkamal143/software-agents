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

  test("a check secret's name is added to the repo once", () => {
    const added = addRepo(starterConfig("alice"), repoEntry("acme/web-app", { checks: { test: ["npm test"] }, network: [] }));
    if (!added.ok) throw new Error(added.problems.join("\n"));
    const twice = addCheckSecret(addCheckSecret(added.text, "acme/web-app", "DATABASE_URL"), "acme/web-app", "DATABASE_URL");
    expect(loadConfig(twice)).toMatchObject({ ok: true, config: { repos: [{ check_secrets: ["DATABASE_URL"] }] } });
    expect(() => addCheckSecret(added.text, "acme/other", "X")).toThrow(/factory repo add acme\/other/);
  });
});
