import { describe, expect, test } from "vitest";
import { resolve } from "../src/config/resolve.js";
import { draftConfig } from "./helpers/config.js";

const job = (repo: string, labels: string[] = []) => ({ repo, labels });

/** The six guided scenarios from the config prototype (prototype/config-shape). */
describe("resolve: the prototype's guided scenarios", () => {
  test("1. ordinary feature: the full feature Pipeline, Autonomy auto set by the repo", () => {
    const r = resolve(draftConfig(), job("acme/web-app"));

    expect(r.errors).toEqual([]);
    expect(r.pipeline).toBe("feature");
    expect(r.pipelineSource).toBe("Target repo default");
    expect(r.stages.map((s) => s.id)).toEqual(["triage", "build", "verify", "review", "security"]);
    expect(r.stages[1]).toMatchObject({ id: "build", kind: "agent", model: "claude-opus-5-5", tools: "write-branch" });
    expect(r.stages[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(r.stages[2]).toMatchObject({ kind: "check", commands: ["pnpm lint", "pnpm typecheck", "pnpm test"] });
    expect(r.policies.autonomy).toBe("auto");
    expect(r.source.autonomy).toBe("Target repo");
    expect(r.source["budgets.job.usd"]).toBe("Factory");
    expect(r.refused).toEqual([]);
  });

  test("2. docs change: pipeline:docs switches Pipeline and tightens bounce cap and Stage-run budget", () => {
    const r = resolve(draftConfig(), job("acme/web-app", ["pipeline:docs"]));

    expect(r.errors).toEqual([]);
    expect(r.pipeline).toBe("docs");
    expect(r.pipelineSource).toBe("Label pipeline:docs");
    expect(r.stages.map((s) => s.id)).toEqual(["build", "docs-check", "review"]);
    expect(r.policies.bounce_cap).toBe(1);
    expect(r.policies.budgets.stage_run).toEqual({ usd: 2, turns: 100, minutes: 30 });
    expect(r.source["budgets.stage_run.usd"]).toBe('Pipeline "docs"');
  });

  test("3. a label that tries to unlock auto-merge is refused, with the reason", () => {
    const r = resolve(draftConfig(), job("acme/payments-api", ["factory:autonomy-auto"]));

    expect(r.policies.autonomy).toBe("off");
    expect(r.refused).toEqual([
      { layer: "Label factory:autonomy-auto", key: "autonomy", value: "auto", why: "would loosen off → auto" },
    ]);
  });

  test("4. labels that tighten are accepted", () => {
    const r = resolve(draftConfig(), job("acme/web-app", ["factory:human-merge", "factory:small-budget"]));

    expect(r.refused).toEqual([]);
    expect(r.policies.autonomy).toBe("off");
    expect(r.policies.budgets.job.usd).toBe(5);
    expect(r.source.autonomy).toBe("Label factory:human-merge");
  });

  test("5. a Pipeline the repo can't run sends the Job to a question instead of skipping the Check Stage", () => {
    const r = resolve(draftConfig(), job("acme/payments-api", ["pipeline:docs"]));

    expect(r.errors).toEqual([
      'Check Stage "docs-check" needs "docs_verify" commands, but acme/payments-api doesn\'t define them.',
    ]);
    expect(r.stages.find((s) => s.id === "docs-check")).toMatchObject({ kind: "check", commands: [] });
  });

  test("Risk rules add up across layers", () => {
    const r = resolve(draftConfig(), job("acme/payments-api"));
    expect(r.riskRules.map((x) => [x.name, x.layer])).toEqual([
      ["auth", "Built-in default"],
      ["payments", "Built-in default"],
      ["migrations", "Built-in default"],
      ["secrets", "Built-in default"],
      ["ci-config", "Built-in default"],
      ["ledger", "Target repo"],
    ]);
  });

  test("two Pipeline labels are a question, not a guess", () => {
    const r = resolve(draftConfig(), job("acme/web-app", ["pipeline:docs", "pipeline:bugfix"]));
    expect(r.errors).toEqual(["Two Pipeline labels (pipeline:docs, pipeline:bugfix). The Job can't start until one is removed."]);
  });

  test("max_running resolves per repo, defaulting to 2", () => {
    expect(resolve(draftConfig(), job("acme/payments-api")).maxRunning).toBe(1);
    expect(resolve(draftConfig(), job("acme/web-app")).maxRunning).toBe(2);
  });
});

describe("resolve: the size cap", () => {
  const withLabels = (patches: Record<string, object>) => {
    const config = draftConfig();
    Object.assign(config.label_overrides, patches);
    return config;
  };

  test("a label can tighten the size cap", () => {
    const r = resolve(withLabels({ "factory:small": { size_cap: 100 } }), job("acme/web-app", ["factory:small"]));
    expect(r.policies.size_cap).toBe(100);
    expect(r.source.size_cap).toBe("Label factory:small");
    expect(r.refused).toEqual([]);
  });

  test("a label can't raise the size cap", () => {
    const r = resolve(withLabels({ "factory:big": { size_cap: 5000 } }), job("acme/web-app", ["factory:big"]));
    expect(r.policies.size_cap).toBe(400);
    expect(r.refused).toEqual([{ layer: "Label factory:big", key: "size_cap", value: 5000, why: "would loosen 400 → 5000" }]);
  });
});

describe("resolve: tighten-only fails closed", () => {
  test("a label setting a Policy key with no strictness rule is refused, not applied", () => {
    const config = draftConfig();
    // A key the schema doesn't know yet, as if added later without a strictness rule.
    (config.label_overrides as Record<string, object>)["factory:odd"] = { new_knob: 1 };
    (config.policies as Record<string, unknown>).new_knob = 5;
    const r = resolve(config, job("acme/web-app", ["factory:odd"]));
    expect(r.refused).toEqual([
      { layer: "Label factory:odd", key: "new_knob", value: 1, why: "has no tighten-only rule, so only Factory or Target repo config may set it" },
    ]);
    expect((r.policies as unknown as Record<string, unknown>).new_knob).toBe(5);
  });

  test("only the Target repo layer switches Risk rules off", () => {
    const config = draftConfig();
    config.repos[0]!.policies = { ...config.repos[0]!.policies, risk_rules_off: ["payments"] };
    const r = resolve(config, job("acme/web-app"));
    expect(r.riskRules.map((x) => x.name)).toEqual(["auth", "migrations", "secrets", "ci-config"]);
  });
});

describe("resolve: how a Target repo merges", () => {
  test("squash by default; a repo may choose merge or rebase", () => {
    expect(resolve(draftConfig(), job("acme/web-app")).mergeMethod).toBe("squash");
    const config = draftConfig();
    config.repos[0]!.merge_method = "rebase";
    expect(resolve(config, job("acme/web-app")).mergeMethod).toBe("rebase");
  });
});

describe("resolve: what each Check Stage gets", () => {
  /** draft.yaml's acme/web-app with two secrets, a network allowlist, and lint beside verify. */
  function config() {
    const c = draftConfig();
    c.stages.lint = { kind: "check", run: "lint", network: true, secrets: ["NPM_TOKEN"] };
    c.pipelines.feature!.stages.splice(3, 0, "lint");
    const repo = c.repos[0]!;
    repo.commands = { ...repo.commands, lint: ["pnpm lint"] };
    repo.check_secrets = ["NPM_TOKEN", "STRIPE_KEY"];
    repo.network = ["registry.npmjs.org"];
    return c;
  }

  test("only the secrets it names, and the repo's network only if it enables it; by default neither", () => {
    const stages = resolve(config(), job("acme/web-app")).stages;
    expect(stages.find((s) => s.id === "verify")).toMatchObject({ secrets: [], network: [] });
    expect(stages.find((s) => s.id === "lint")).toMatchObject({ secrets: ["NPM_TOKEN"], network: ["registry.npmjs.org"] });
  });

  test("a secret the repo doesn't have is a question, not a check run without it", () => {
    const c = config();
    c.repos[0]!.check_secrets = ["STRIPE_KEY"];
    const r = resolve(c, job("acme/web-app"));
    expect(r.errors).toEqual(['Check Stage "lint" gets check secret NPM_TOKEN, but acme/web-app doesn\'t have it in check_secrets (add it with `factory secret set acme/web-app NPM_TOKEN`).']);
  });
});

describe("resolve: Stage skills (ADR 0012)", () => {
  test("a Stage gets its library skills, less those the Target repo switched off", () => {
    const config = draftConfig();
    const review = config.stages.review!;
    if (review.kind !== "agent") throw new Error("review should be an Agent Stage");
    review.skill = "super-review";
    review.supporting = ["ponytail-review", "blast-radius"];
    const repo = config.repos.find((r) => r.name === "acme/web-app")!;
    repo.stage_overrides = { review: { skills_off: ["blast-radius"] } };

    const stage = resolve(config, job("acme/web-app")).stages.find((s) => s.id === "review");
    expect(stage).toMatchObject({ skill: "super-review", supporting: ["ponytail-review"] });

    repo.stage_overrides = { review: { skills_off: ["super-review"] } };
    const without = resolve(config, job("acme/web-app")).stages.find((s) => s.id === "review");
    expect(without).not.toHaveProperty("skill");
    expect(without).toMatchObject({ supporting: ["ponytail-review", "blast-radius"] });
  });
});
