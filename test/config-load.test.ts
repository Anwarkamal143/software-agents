import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { fixture } from "./helpers/config.js";

const problems = (name: string) => {
  const r = loadConfig(fixture(name));
  return r.ok ? [] : r.problems;
};

describe("loadConfig", () => {
  test("the draft config loads, warning about Pipelines a repo can't run", () => {
    const r = loadConfig(fixture("draft.yaml"));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'Target repo acme/payments-api can\'t run Pipeline "docs": Check Stage "docs-check" needs "docs_verify" commands.',
    ]);
  });

  test("a minimal config gets the documented defaults", () => {
    const r = loadConfig(fixture("minimal.yaml"));
    if (!r.ok) throw new Error(r.problems.join("\n"));
    expect(r.config.max_running).toBe(2);
    expect(r.config.agent).toEqual({ adapter: "claude", auth: "api-key", model: "claude-sonnet-5-5" });
    expect(r.config.state).toEqual({ store: "sqlite", mirrors: ["github"] });
    expect(r.config.sources).toEqual([{ kind: "github-issues", ready_label: "factory:ready" }]);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("6. broken config (prototype scenario): every mistake is listed", () => {
    const broken = fixture("draft.yaml")
      .replace("stages: [build, docs-check, review]", "stages: [build, review]")
      .replace("triage: { kind: agent, instructions: factory:triage, tools: read-only }", "triage: { kind: agent, instructions: factory:triage, tools: read-only, on_fail: build }")
      .replace("bugfix: { stages: [triage, build, verify, review] }", "bugfix: { stages: [triage, build, verify, review], policies: { budgets: { daily: { usd: 500 } } } }");
    const r = loadConfig(broken);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problems).toEqual([
      'Pipeline "feature": Stage "triage" bounces forward to "build". A Bounce must go to an earlier Stage.',
      'Pipeline "bugfix": Stage "triage" bounces forward to "build". A Bounce must go to an earlier Stage.',
      'Pipeline "bugfix" sets budgets.daily.usd, which only Factory config may set.',
      'Pipeline "docs" has no Check Stage, so the Merge gate can never pass (no Evidence).',
    ]);
  });

  test.each([
    ["no-check-stage.yaml", 'Pipeline "feature" has no Check Stage, so the Merge gate can never pass (no Evidence).'],
    ["bounce-forward.yaml", 'Pipeline "feature": Stage "build" bounces forward to "review". A Bounce must go to an earlier Stage.'],
    ["bounce-outside-pipeline.yaml", 'Pipeline "feature": Stage "review" bounces to "build", which isn\'t in this Pipeline.'],
    ["missing-stage.yaml", 'Pipeline "feature" uses Stage "lint", which isn\'t defined.'],
    ["missing-pipeline.yaml", 'Target repo acme/web-app: default Pipeline "bugfix" doesn\'t exist.'],
    ["repo-sets-daily-budget.yaml", "Target repo acme/web-app sets budgets.daily.usd, which only Factory config may set."],
    ["repo-sets-sign-in-mode.yaml", "Target repo acme/web-app sets agent.auth (sign-in mode), which only Factory config may set."],
    ["repo-sets-job-store.yaml", "Target repo acme/web-app sets state (Job store and Mirrors), which only Factory config may set."],
    ["pipeline-sets-daily-budget.yaml", 'Pipeline "feature" sets budgets.daily.usd, which only Factory config may set.'],
    ["label-sets-daily-budget.yaml", 'Label override "factory:big-day" sets budgets.daily.usd, which only Factory config may set.'],
    ["literal-secret.yaml", "agent.api_key must be a reference like ${env:NAME} or keychain:NAME, never the secret itself."],
    ["literal-postgres-url.yaml", "state.postgres_url must be a reference like ${env:NAME} or keychain:NAME, never the secret itself."],
    ["bad-check-secret-name.yaml", 'repos.0.check_secrets.0 must match pattern "^[A-Za-z_][A-Za-z0-9_]*$".'],
  ])("refuses %s", (name, problem) => {
    expect(problems(`refused/${name}`)).toEqual([problem]);
  });

  test("a schema mistake is reported with where it is", () => {
    const r = loadConfig(fixture("minimal.yaml").replace("tools: read-only", "tools: everything"));
    expect(r.ok ? [] : r.problems).toContain("stages.review.tools must be one of read-only, write-branch.");
  });

  test("YAML that doesn't parse is refused", () => {
    const r = loadConfig("version: 1\nhumans: [alice\n");
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problems[0]).toMatch(/^YAML: /);
  });
});

describe("loadConfig: layer rules", () => {
  test("the Factory layer can't switch Risk rules off; only a Target repo can", () => {
    const r = loadConfig(fixture("minimal.yaml") + "policies: { risk_rules_off: [auth] }\n");
    expect(r.ok ? [] : r.problems).toEqual(["policies.risk_rules_off: only a Target repo may switch Risk rules off."]);
  });

  test("a Postgres Job store is refused until it is built", () => {
    const r = loadConfig(fixture("minimal.yaml") + 'state: { store: postgres, postgres_url: "${env:FACTORY_PG}" }\n');
    expect(r.ok ? [] : r.problems).toEqual(["state.store: postgres isn't available yet; use sqlite."]);
  });
});

describe("loadConfig: merge_method", () => {
  test("only squash, merge or rebase", () => {
    const with_ = (m: string) => loadConfig(fixture("minimal.yaml").replace(/( {2}- name: [^\n]+\n)/, `$1    merge_method: ${m}\n`));
    expect(with_("rebase").ok).toBe(true);
    const bad = with_("fast-forward");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join("\n")).toMatch(/merge_method/);
  });
});
