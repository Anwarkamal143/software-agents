import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject } from "ajv";
import { parseDocument } from "yaml";
import { pluginSkills, skillName } from "../agents/plugin.js";
import { stageSkillNames } from "../agents/stage-skills.js";
import { BUILT_IN_RISK_RULES, FACTORY_WIDE_POLICY_KEYS, flatten } from "./policies.js";
import type { WorkingCopy } from "../repos/clones.js";
import type { FactoryConfig } from "./types.js";

const CONFIG_SCHEMA = JSON.parse(
  readFileSync(new URL("../../schema/factory.schema.json", import.meta.url), "utf8"),
) as object;

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const checkSchema = ajv.compile<FactoryConfig>(CONFIG_SCHEMA);

export type LoadResult =
  | { ok: true; config: FactoryConfig; warnings: string[]; /** sha256 of the file text; Stage runs record it. */ hash: string }
  | { ok: false; problems: string[]; warnings: string[] };

/**
 * Parses and checks `factory.yaml` text: the JSON Schema first, then the rules
 * the Orchestrator refuses to start without (ADR 0005, Factory config, #23).
 */
export function loadConfig(text: string): LoadResult {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) return { ok: false, problems: doc.errors.map((e) => `YAML: ${e.message}`), warnings: [] };

  const raw = doc.toJS() as unknown;
  if (!checkSchema(raw)) return { ok: false, problems: (checkSchema.errors ?? []).map(formatSchemaError), warnings: [] };

  const config = raw;
  const problems = semanticProblems(config);
  const warnings = unrunnableChecks(config);
  if (problems.length) return { ok: false, problems, warnings };
  return { ok: true, config, warnings, hash: hashConfigText(text) };
}

/** sha256 of the config text: what a Stage run records as the config it used. */
export const hashConfigText = (text: string) => createHash("sha256").update(text).digest("hex");

function formatSchemaError(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "factory.yaml";
  if (e.keyword === "additionalProperties") {
    return `${where}: unknown setting "${(e.params as { additionalProperty: string }).additionalProperty}".`;
  }
  if (e.keyword === "enum") return `${where} must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}.`;
  return `${where} ${e.message}.`;
}

/**
 * The env vars every check command gets from the Factory: the Attempt's own folders, then PATH.
 * They win over a check secret of the same name, which the command would then never see.
 */
const CHECK_ENV = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "npm_config_cache", "TMPDIR"] as const satisfies readonly ("PATH" | keyof WorkingCopy["env"])[];

/** A check secret becomes an env var of the same name. */
export const isCheckSecretName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

const SECRET_REF = /^(\$\{env:[A-Za-z_][A-Za-z0-9_]*\}|keychain:[A-Za-z_][A-Za-z0-9_.-]*)$/;

/** A lower layer setting a Factory-wide Policy value. */
function factoryWideKeys(at: string, patch: object | undefined): string[] {
  return Object.keys(flatten(patch))
    .filter((key) => FACTORY_WIDE_POLICY_KEYS.has(key))
    .map((key) => `${at} sets ${key}, which only Factory config may set.`);
}

/** Null if `ref` names a skill the Factory plugin has, else why not. */
function unknownInstructions(ref: string, skills: string[]): string | null {
  const name = skillName(ref);
  return name && skills.includes(name) ? null : `the Factory plugin has no instructions ${ref}.`;
}

function semanticProblems(config: FactoryConfig): string[] {
  const problems: string[] = [];
  const skills = pluginSkills();
  const pinned = new Set(stageSkillNames());

  for (const [id, stage] of Object.entries(config.stages)) {
    if (stage.kind !== "agent") continue;
    const unknown = unknownInstructions(stage.instructions, skills);
    if (unknown) problems.push(`Stage "${id}": ${unknown}`);
    for (const name of [...(stage.skill ? [stage.skill] : []), ...(stage.supporting ?? [])]) {
      if (!pinned.has(name)) problems.push(`Stage "${id}": "${name}" isn't a pinned Stage skill. Pin it with scripts/pin-stage-skill.mjs first (ADR 0012).`);
    }
    if (stage.skill && stage.supporting?.includes(stage.skill)) problems.push(`Stage "${id}": "${stage.skill}" is its main Stage skill, so it can't be a supporting one too.`);
  }

  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    const ids = pipeline.stages;
    ids.forEach((id, i) => {
      const stage = config.stages[id];
      if (!stage) return problems.push(`Pipeline "${name}" uses Stage "${id}", which isn't defined.`);
      if (stage.on_fail) {
        const j = ids.indexOf(stage.on_fail);
        if (j === -1) problems.push(`Pipeline "${name}": Stage "${id}" bounces to "${stage.on_fail}", which isn't in this Pipeline.`);
        else if (j >= i) problems.push(`Pipeline "${name}": Stage "${id}" bounces forward to "${stage.on_fail}". A Bounce must go to an earlier Stage.`);
      }
    });
    if (!ids.some((id) => config.stages[id]?.kind === "check")) {
      problems.push(`Pipeline "${name}" has no Check Stage, so the Merge gate can never pass (no Evidence).`);
    }
    problems.push(...factoryWideKeys(`Pipeline "${name}"`, pipeline.policies));
  }

  for (const [label, patch] of Object.entries(config.label_overrides)) {
    if (label.startsWith("pipeline:")) problems.push(`Label override "${label}": pipeline:<name> labels only choose a Pipeline.`);
    problems.push(...factoryWideKeys(`Label override "${label}"`, patch));
  }

  const knownRules = new Set([...BUILT_IN_RISK_RULES, ...(config.policies.risk_rules ?? [])].map((r) => r.name));
  if (config.policies.risk_rules_off) problems.push(`policies.risk_rules_off: only a Target repo may switch Risk rules off.`);

  const seen = new Set<string>();
  for (const repo of config.repos) {
    const at = `Target repo ${repo.name}`;
    if (seen.has(repo.name)) problems.push(`${at} is listed twice.`);
    seen.add(repo.name);
    if (!config.pipelines[repo.default_pipeline]) problems.push(`${at}: default Pipeline "${repo.default_pipeline}" doesn't exist.`);
    problems.push(...factoryWideKeys(at, repo.policies));
    if (repo.agent?.auth !== undefined) problems.push(`${at} sets agent.auth (sign-in mode), which only Factory config may set.`);
    if (repo.state !== undefined) problems.push(`${at} sets state (Job store and Mirrors), which only Factory config may set.`);
    for (const name of repo.check_secrets ?? []) {
      if ((CHECK_ENV as readonly string[]).includes(name)) {
        problems.push(`${at}: check secret ${name} is named like one of the env vars the Factory sets for every check (${CHECK_ENV.join(", ")}), so the command would never see it. Rename it.`);
      }
    }
    for (const off of repo.policies?.risk_rules_off ?? []) {
      if (!knownRules.has(off)) problems.push(`${at}: risk_rules_off names "${off}", which isn't a Factory Risk rule.`);
    }
    for (const id of Object.keys(repo.stage_overrides ?? {})) {
      if (!config.stages[id]) problems.push(`${at}: stage_overrides names Stage "${id}", which isn't defined.`);
      else if (config.stages[id].kind !== "agent") problems.push(`${at}: stage_overrides on Check Stage "${id}"; only Agent Stages have a model and instructions.`);
      const ref = repo.stage_overrides?.[id]?.instructions;
      const unknown = ref === undefined ? null : unknownInstructions(ref, skills);
      if (unknown) problems.push(`${at}: stage_overrides.${id}: ${unknown}`);
      const stage = config.stages[id];
      const has = stage?.kind === "agent" ? [...(stage.skill ? [stage.skill] : []), ...(stage.supporting ?? [])] : [];
      for (const off of repo.stage_overrides?.[id]?.skills_off ?? []) {
        if (!has.includes(off)) problems.push(`${at}: stage_overrides.${id}.skills_off names "${off}", which Stage "${id}" doesn't run. A repo can switch Stage skills off, never add one.`);
      }
    }
  }

  const secrets: Array<[string, string | undefined]> = [
    ["agent.api_key", config.agent.api_key],
    ["state.postgres_url", config.state.postgres_url],
  ];
  for (const [where, value] of secrets) {
    if (value !== undefined && !SECRET_REF.test(value)) {
      problems.push(`${where} must be a reference like \${env:NAME} or keychain:NAME, never the secret itself.`);
    }
  }
  // The Postgres Job store sits behind the same interface later (ADR 0002); refuse rather than silently use SQLite.
  if (config.state.store === "postgres") problems.push(`state.store: postgres isn't available yet; use sqlite.`);

  return problems;
}

/**
 * A Check Stage a repo could reach but has no commands or secrets for: a warning, and a question
 * if a Job picks it. And a check secret no Check Stage names, which no check gets.
 */
function unrunnableChecks(config: FactoryConfig): string[] {
  const warnings: string[] = [];
  const named = new Set(Object.values(config.stages).flatMap((s) => (s.kind === "check" ? (s.secrets ?? []) : [])));
  for (const repo of config.repos) {
    for (const secret of (repo.check_secrets ?? []).filter((s) => !named.has(s))) {
      warnings.push(`Target repo ${repo.name}: no Check Stage names check secret ${secret} in its secrets, so no check gets it.`);
    }
    for (const [name, pipeline] of Object.entries(config.pipelines)) {
      for (const id of pipeline.stages) {
        const stage = config.stages[id];
        if (stage?.kind !== "check") continue;
        const why = `Target repo ${repo.name} can't run Pipeline "${name}": Check Stage "${id}"`;
        if (!repo.commands?.[stage.run]?.length) warnings.push(`${why} needs "${stage.run}" commands.`);
        for (const secret of (stage.secrets ?? []).filter((s) => !repo.check_secrets?.includes(s))) {
          warnings.push(`${why} gets check secret ${secret}, which isn't in its check_secrets.`);
        }
      }
    }
  }
  return warnings;
}
