import { isMap, isSeq, parseDocument, stringify } from "yaml";
import { loadConfig } from "../config/load.js";
import type { Pipeline, Stage, TargetRepo } from "../config/types.js";
import type { Proposal } from "./propose.js";

/** The default Agent Stages around a repo's Check Stages (#34): triage and build before, review and security after. */
const BEFORE_CHECKS = ["triage", "build"];
const AFTER_CHECKS = ["review", "security"];

/** The Stage library `factory init` starts with. */
export const STARTER_STAGES: Record<string, Stage> = {
  triage: { kind: "agent", instructions: "factory:triage", tools: "read-only" },
  build: { kind: "agent", instructions: "factory:build", tools: "write-branch" },
  test: { kind: "check", run: "test", on_fail: "build" },
  review: { kind: "agent", instructions: "factory:review", tools: "read-only", on_fail: "build" },
  security: { kind: "agent", instructions: "factory:security-review", tools: "read-only", on_fail: "build" },
};

/** The `factory.yaml` that `factory init` writes: you as the one allowed human, the default Stages, no repos yet. */
export function starterConfig(human: string): string {
  const stages = Object.entries(STARTER_STAGES)
    .map(([id, s]) => `  ${id}: ${stringify(s, { collectionStyle: "flow", lineWidth: 0 }).trim()}`)
    .join("\n");
  return `# Software Factory configuration (ADR 0005). Check it with \`factory config check\`.
version: 1
# GitHub logins allowed to approve Jobs (the factory:ready label) and send Reply commands.
humans: [${human}]
agent:
  # subscription: your Claude login. api-key: set api_key to keychain:NAME or \${env:NAME}.
  auth: subscription
stages:
${stages}
pipelines:
  default: { stages: [triage, build, test, review, security] }
# Added by \`factory repo add <owner/repo>\`.
repos: []
`;
}

/** What `factory repo add` writes for one repo: its entry and the Pipeline it defaults to. */
export interface RepoEntry {
  repo: Pick<TargetRepo, "name" | "default_pipeline" | "commands" | "network">;
  pipeline: Pipeline;
}

/** The entry a proposal becomes: a Pipeline of its own, named after the repo, running its Check Stages. */
export function repoEntry(name: string, proposal: Proposal): RepoEntry {
  return {
    repo: { name, default_pipeline: name, commands: proposal.checks, network: proposal.network },
    pipeline: { stages: [...BEFORE_CHECKS, ...Object.keys(proposal.checks), ...AFTER_CHECKS] },
  };
}

/** The entry as YAML, for you to confirm or edit. */
export function renderRepoEntry(entry: RepoEntry): string {
  return stringify({ repo: entry.repo, pipeline: entry.pipeline }, { lineWidth: 0 });
}

/** Reads back an edited entry, or says what's wrong with it. */
export function parseRepoEntry(text: string, name: string): { ok: true; entry: RepoEntry } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = parseDocument(text, { prettyErrors: false }).toJS();
  } catch (err) {
    return { ok: false, problem: `YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const r = raw as Partial<RepoEntry> | null;
  if (!r || typeof r !== "object" || !r.repo || !r.pipeline) return { ok: false, problem: "It needs a `repo` and a `pipeline`." };
  if (r.repo.name !== name) return { ok: false, problem: `repo.name must stay ${name}.` };
  return { ok: true, entry: r as RepoEntry };
}

/**
 * `factory.yaml` text with the repo added, comments and layout kept: the repo's entry, its
 * Pipeline, and a library Check Stage (`run: <name>`, Bouncing to build) for each Check Stage
 * it names that the library doesn't have yet. The result must pass `factory config check`.
 */
export function addRepo(configText: string, entry: RepoEntry): { ok: true; text: string } | { ok: false; problems: string[] } {
  const doc = parseDocument(configText);
  const stages = doc.get("stages");
  for (const id of entry.pipeline.stages) {
    if (isMap(stages) && stages.has(id)) continue;
    const stage: Stage = STARTER_STAGES[id]?.kind === "agent" ? STARTER_STAGES[id] : { kind: "check", run: id, on_fail: "build" };
    doc.setIn(["stages", id], doc.createNode(stage, { flow: true }));
  }
  doc.setIn(["pipelines", entry.repo.default_pipeline], doc.createNode(entry.pipeline, { flow: true }));
  const repos = doc.get("repos");
  if (isSeq(repos)) {
    repos.flow = false;
    repos.add(doc.createNode(entry.repo));
  } else doc.set("repos", doc.createNode([entry.repo]));
  const text = doc.toString({ lineWidth: 0 });
  const loaded = loadConfig(text);
  return loaded.ok ? { ok: true, text } : { ok: false, problems: loaded.problems };
}

/** `factory.yaml` text with `name` among the repo's check secrets, added once. */
export function addCheckSecret(configText: string, repo: string, name: string): string {
  const doc = parseDocument(configText);
  const repos = doc.get("repos");
  const index = isSeq(repos) ? repos.items.findIndex((r) => isMap(r) && r.get("name") === repo) : -1;
  if (index === -1) throw new Error(`${repo} isn't a Target repo in factory.yaml: add it with \`factory repo add ${repo}\` first.`);
  const current = doc.getIn(["repos", index, "check_secrets"]);
  if (isSeq(current)) {
    if (!current.items.some((i) => String((i as { value?: unknown }).value ?? i) === name)) current.add(name);
  } else doc.setIn(["repos", index, "check_secrets"], doc.createNode([name], { flow: true }));
  return doc.toString({ lineWidth: 0 });
}
