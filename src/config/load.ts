import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject } from "ajv";
import { parseDocument } from "yaml";
import { BUILT_IN_RISK_RULES, FACTORY_WIDE_POLICY_KEYS, flatten } from "./policies.js";
import type { FactoryConfig } from "./types.js";

export const CONFIG_SCHEMA = JSON.parse(
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
  return { ok: true, config, warnings, hash: createHash("sha256").update(text).digest("hex") };
}

function formatSchemaError(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "factory.yaml";
  if (e.keyword === "additionalProperties") {
    return `${where}: unknown setting "${(e.params as { additionalProperty: string }).additionalProperty}".`;
  }
  if (e.keyword === "enum") return `${where} must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}.`;
  return `${where} ${e.message}.`;
}

const SECRET_REF = /^(\$\{env:[A-Za-z_][A-Za-z0-9_]*\}|keychain:[A-Za-z_][A-Za-z0-9_.-]*)$/;

function semanticProblems(config: FactoryConfig): string[] {
  const problems: string[] = [];

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
    for (const key of Object.keys(flatten(pipeline.policies))) {
      if (FACTORY_WIDE_POLICY_KEYS.has(key)) problems.push(`Pipeline "${name}" sets ${key}, which only Factory config may set.`);
    }
  }

  for (const [label, patch] of Object.entries(config.label_overrides)) {
    if (label.startsWith("pipeline:")) problems.push(`Label override "${label}": pipeline:<name> labels only choose a Pipeline.`);
    for (const key of Object.keys(flatten(patch))) {
      if (FACTORY_WIDE_POLICY_KEYS.has(key)) problems.push(`Label override "${label}" sets ${key}, which only Factory config may set.`);
    }
  }

  const knownRules = new Set([...BUILT_IN_RISK_RULES, ...(config.policies.risk_rules ?? [])].map((r) => r.name));
  for (const off of config.policies.risk_rules_off ?? []) {
    if (!BUILT_IN_RISK_RULES.some((r) => r.name === off)) problems.push(`policies.risk_rules_off: no built-in Risk rule is named "${off}".`);
  }

  const seen = new Set<string>();
  for (const repo of config.repos) {
    const at = `Target repo ${repo.name}`;
    if (seen.has(repo.name)) problems.push(`${at} is listed twice.`);
    seen.add(repo.name);
    if (!config.pipelines[repo.default_pipeline]) problems.push(`${at}: default Pipeline "${repo.default_pipeline}" doesn't exist.`);
    for (const key of Object.keys(flatten(repo.policies))) {
      if (FACTORY_WIDE_POLICY_KEYS.has(key)) problems.push(`${at} sets ${key}, which only Factory config may set.`);
    }
    if (repo.agent?.auth !== undefined) problems.push(`${at} sets agent.auth (sign-in mode), which only Factory config may set.`);
    if (repo.state !== undefined) problems.push(`${at} sets state (Job store and Mirrors), which only Factory config may set.`);
    for (const off of repo.policies?.risk_rules_off ?? []) {
      if (!knownRules.has(off)) problems.push(`${at}: risk_rules_off names "${off}", which isn't a Factory Risk rule.`);
    }
    for (const id of Object.keys(repo.stage_overrides ?? {})) {
      if (!config.stages[id]) problems.push(`${at}: stage_overrides names Stage "${id}", which isn't defined.`);
      else if (config.stages[id].kind !== "agent") problems.push(`${at}: stage_overrides on Check Stage "${id}"; only Agent Stages have a model and instructions.`);
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
  if (config.state.store === "postgres" && !config.state.postgres_url) problems.push(`state.store is postgres but state.postgres_url isn't set.`);

  return problems;
}

/** A Check Stage a repo could reach but has no commands for: a warning, and a question if a Job picks it. */
function unrunnableChecks(config: FactoryConfig): string[] {
  const warnings: string[] = [];
  for (const repo of config.repos) {
    for (const [name, pipeline] of Object.entries(config.pipelines)) {
      for (const id of pipeline.stages) {
        const stage = config.stages[id];
        if (stage?.kind === "check" && !repo.commands?.[stage.run]?.length) {
          warnings.push(`Target repo ${repo.name} can't run Pipeline "${name}": Check Stage "${id}" needs "${stage.run}" commands.`);
        }
      }
    }
  }
  return warnings;
}
