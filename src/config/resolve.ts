import { AT_LEAST_AS_STRICT, BUILT_IN_POLICIES, BUILT_IN_RISK_RULES, FACTORY_WIDE_POLICY_KEYS, flatten, unflatten } from "./policies.js";
import type { FactoryConfig, MergeMethod, OwnerPolicyPatch, Policies, RiskRule, StageCondition, ToolProfile } from "./types.js";

export interface JobInput {
  /** `owner/repo` */
  repo: string;
  labels: string[];
}

export interface ResolvedStage {
  id: string;
  kind: "agent" | "check";
  on_fail?: string;
  /** Agent Stages */
  model?: string;
  instructions?: string;
  /** The main Stage skill, if the Stage has one and the repo didn't switch it off. */
  skill?: string;
  /** The file in the main Stage skill to start from, when it isn't SKILL.md. */
  entry?: string;
  /** Supporting Stage skills, less any the repo switched off. */
  supporting?: string[];
  tools?: ToolProfile;
  /** Check Stages: the repo's commands, empty if it has none. */
  commands?: string[];
  /**
   * The repo's `network` hosts. A Check Stage gets them only if it enables `network` (empty
   * otherwise); an Agent Stage gets them only if it writes the branch.
   */
  network?: string[];
  /** Check Stages: names of the repo's check secrets the Stage names, kept in the keychain under `checkSecretKey`. */
  secrets?: string[];
  when?: StageCondition;
}

export interface Refusal {
  layer: string;
  key: string;
  value: unknown;
  why: string;
}

export interface Resolution {
  /** Reasons the Job can't start as labelled. Each one becomes a question to a human, never a guess. */
  errors: string[];
  pipeline: string | null;
  pipelineSource: string | null;
  stages: ResolvedStage[];
  policies: Policies;
  /** Which layer set each Policy key, e.g. `{ "budgets.job.usd": "Factory" }`. */
  source: Record<string, string>;
  /** Overrides that were ignored, with why. */
  refused: Refusal[];
  riskRules: (RiskRule & { layer: string })[];
  /** The Target repo's cap on concurrent Stage runs. */
  maxRunning: number;
  /** How the Factory merges the Target repo's PRs. */
  mergeMethod: MergeMethod;
}

interface Layer {
  layer: string;
  patch: OwnerPolicyPatch | undefined;
  /** The Factory and Target repo layers are owner-controlled and may loosen. */
  mayLoosen: boolean;
  factoryLayer: boolean;
}

const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));

/**
 * The Pipeline and Policies one Job gets: Factory → Target repo → Pipeline →
 * label, where Pipelines and labels only tighten (ADR 0004). Pure; the config
 * must already have passed `loadConfig`.
 */
export function resolve(config: FactoryConfig, job: JobInput): Resolution {
  const errors: string[] = [];
  const cannotStart = (why: string): Resolution => ({
    errors: [...errors, why],
    pipeline: null,
    pipelineSource: null,
    stages: [],
    policies: structuredClone(BUILT_IN_POLICIES),
    source: {},
    refused: [],
    riskRules: [],
    maxRunning: 0,
    mergeMethod: "squash",
  });

  const repo = config.repos.find((r) => r.name === job.repo);
  if (!repo) return cannotStart(`${job.repo} isn't a Target repo in factory.yaml.`);

  const pipeLabels = job.labels.filter((l) => l.startsWith("pipeline:"));
  if (pipeLabels.length > 1) errors.push(`Two Pipeline labels (${pipeLabels.join(", ")}). The Job can't start until one is removed.`);
  const pipelineName = pipeLabels[0]?.slice("pipeline:".length) ?? repo.default_pipeline;
  const pipeline = config.pipelines[pipelineName];
  if (!pipeline) return cannotStart(`Pipeline "${pipelineName}" doesn't exist.`);

  const layers: Layer[] = [
    { layer: "Built-in default", patch: { ...BUILT_IN_POLICIES, risk_rules: BUILT_IN_RISK_RULES }, mayLoosen: true, factoryLayer: true },
    { layer: "Factory", patch: config.policies, mayLoosen: true, factoryLayer: true },
    { layer: "Target repo", patch: repo.policies, mayLoosen: true, factoryLayer: false },
    { layer: `Pipeline "${pipelineName}"`, patch: pipeline.policies, mayLoosen: false, factoryLayer: false },
    ...job.labels
      .filter((l) => config.label_overrides[l])
      .map((l) => ({ layer: `Label ${l}`, patch: config.label_overrides[l], mayLoosen: false, factoryLayer: false })),
  ];

  const flat: Record<string, unknown> = {};
  const source: Record<string, string> = {};
  const refused: Refusal[] = [];
  let riskRules: (RiskRule & { layer: string })[] = [];
  for (const L of layers) {
    for (const [key, value] of Object.entries(flatten(L.patch))) {
      if (FACTORY_WIDE_POLICY_KEYS.has(key) && !L.factoryLayer) {
        refused.push({ layer: L.layer, key, value, why: "only Factory config may set this" });
        continue;
      }
      const stricter = AT_LEAST_AS_STRICT[key];
      // Fail closed: a key with no tighten-only rule can't be set by a tighten-only layer.
      if (!L.mayLoosen && !stricter) {
        refused.push({ layer: L.layer, key, value, why: "has no tighten-only rule, so only Factory or Target repo config may set it" });
        continue;
      }
      if (key in flat && !L.mayLoosen && stricter && !stricter(flat[key], value)) {
        refused.push({ layer: L.layer, key, value, why: `would loosen ${fmt(flat[key])} → ${fmt(value)}` });
        continue;
      }
      flat[key] = value;
      source[key] = L.layer;
    }
    // Risk rules add up; only the Target repo layer may switch earlier ones off, by name.
    if (L.layer === "Target repo" && L.patch?.risk_rules_off) {
      const off = new Set(L.patch.risk_rules_off);
      riskRules = riskRules.filter((r) => !off.has(r.name));
    }
    riskRules = riskRules.concat((L.patch?.risk_rules ?? []).map((r) => ({ ...r, layer: L.layer })));
  }

  const stages = pipeline.stages.map((id): ResolvedStage => {
    const stage = config.stages[id]!;
    if (stage.kind === "check") {
      const commands = repo.commands?.[stage.run] ?? [];
      if (!commands.length) errors.push(`Check Stage "${id}" needs "${stage.run}" commands, but ${repo.name} doesn't define them.`);
      const secrets = stage.secrets ?? [];
      for (const name of secrets.filter((n) => !repo.check_secrets?.includes(n))) {
        errors.push(`Check Stage "${id}" gets check secret ${name}, but ${repo.name} doesn't have it in check_secrets (add it with \`factory secret set ${repo.name} ${name}\`).`);
      }
      // Closed unless the Stage opens it (ADR 0007).
      const network = stage.network ? (repo.network ?? []) : [];
      return { id, kind: "check", commands, network, secrets, ...(stage.on_fail && { on_fail: stage.on_fail }), ...(stage.when && { when: stage.when }) };
    }
    const override = repo.stage_overrides?.[id];
    const off = new Set(override?.skills_off ?? []);
    const skill = stage.skill && !off.has(stage.skill) ? stage.skill : undefined;
    return {
      id,
      kind: "agent",
      tools: stage.tools,
      network: repo.network ?? [],
      model: override?.model ?? stage.model ?? repo.agent?.model ?? config.agent.model,
      instructions: override?.instructions ?? stage.instructions,
      ...(skill && { skill, ...(stage.entry && { entry: stage.entry }) }),
      supporting: (stage.supporting ?? []).filter((s) => !off.has(s)),
      ...(stage.on_fail && { on_fail: stage.on_fail }),
      ...(stage.when && { when: stage.when }),
    };
  });

  return {
    errors,
    pipeline: pipelineName,
    pipelineSource: pipeLabels[0] ? `Label ${pipeLabels[0]}` : "Target repo default",
    stages,
    policies: unflatten(flat) as unknown as Policies,
    source,
    refused,
    riskRules,
    maxRunning: repo.max_running ?? 2,
    mergeMethod: repo.merge_method ?? "squash",
  };
}
