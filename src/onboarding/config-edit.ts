import { isMap, isSeq, parseDocument, stringify } from "yaml";
import { isCheckSecretName, loadConfig } from "../config/load.js";
import type { FactoryConfig, Pipeline, Stage, TargetRepo } from "../config/types.js";
import type { Proposal } from "./propose.js";

/** The default Agent Stages around a repo's Check Stages (#34): triage and build before, review and security after. */
const BEFORE_CHECKS = ["triage", "build"];
const AFTER_CHECKS = ["review", "security"];

/** The Stage library `factory init` starts with. */
export const STARTER_STAGES: Record<string, Stage> = {
  triage: { kind: "agent", instructions: "factory:triage", skill: "triage", entry: "AGENT-BRIEF.md", supporting: ["unslop"], tools: "read-only" },
  build: { kind: "agent", instructions: "factory:build", skill: "super-build", entry: "references/decision-policy.md", supporting: ["diagnosing-bugs", "tdd", "ponytail", "unslop"], tools: "write-branch" },
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
  repo: Pick<TargetRepo, "name" | "default_pipeline" | "commands" | "network" | "check_secrets">;
  pipeline: Pipeline;
}

/** The entry a proposal becomes: a Pipeline of its own, named after the repo, running its Check Stages with `secrets`. */
export function repoEntry(name: string, proposal: Proposal, secrets: string[] = []): RepoEntry {
  return {
    repo: { name, default_pipeline: name, commands: proposal.checks, network: proposal.network, ...(secrets.length && { check_secrets: secrets }) },
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
 * it names that the library doesn't have yet. Each of its Check Stages is opened to the repo's
 * network if it has hosts, and names its check secrets (ADR 0007). Widening a Check Stage another
 * repo shares, to its network or a secret it doesn't have, is refused. The result must pass `factory config check`.
 */
export function addRepo(configText: string, entry: RepoEntry): { ok: true; text: string; config: FactoryConfig } | { ok: false; problems: string[] } {
  const doc = parseDocument(configText);
  const before = loadConfig(configText);
  const stages = doc.get("stages");
  const network = (entry.repo.network?.length ?? 0) > 0;
  // A bad name is reported once, on the repo, not again on every Stage.
  const secrets = (entry.repo.check_secrets ?? []).filter(isCheckSecretName);
  const problems: string[] = [];
  for (const id of entry.pipeline.stages) {
    const existing = before.ok ? before.config.stages[id] : undefined;
    if (!(isMap(stages) && stages.has(id))) {
      const stage: Stage =
        STARTER_STAGES[id]?.kind === "agent" ? STARTER_STAGES[id] : { kind: "check", run: id, on_fail: "build", ...(network && { network: true }), ...(secrets.length && { secrets }) };
      doc.setIn(["stages", id], doc.createNode(stage, { flow: true }));
      continue;
    }
    if (existing?.kind !== "check" || !before.ok) continue;
    const own = `Give ${entry.repo.name} a Check Stage of its own: rename it in the pipeline and in commands.`;
    if (network && !existing.network) {
      // Opening it would open it for every repo that runs it, to that repo's own hosts.
      const other = otherRepoRunning(before.config, id, (r) => (r.network?.length ?? 0) > 0);
      if (other) problems.push(`${entry.repo.name} needs the network on Check Stage "${id}", which ${other} also runs with it closed. ${own}`);
      doc.setIn(["stages", id, "network"], true);
    }
    const missing = secrets.filter((n) => !existing.secrets?.includes(n));
    if (!missing.length) continue;
    for (const name of missing) {
      const other = otherRepoRunning(before.config, id, (r) => !r.check_secrets?.includes(name));
      if (other) problems.push(`${entry.repo.name}'s check secret ${name} would go on Check Stage "${id}", which ${other} also runs without that secret. ${own}`);
    }
    doc.setIn(["stages", id, "secrets"], doc.createNode([...(existing.secrets ?? []), ...missing], { flow: true }));
  }
  if (problems.length) return { ok: false, problems };
  doc.setIn(["pipelines", entry.repo.default_pipeline], doc.createNode(entry.pipeline, { flow: true }));
  const repos = doc.get("repos");
  if (isSeq(repos)) {
    repos.flow = false;
    repos.add(doc.createNode(entry.repo));
  } else doc.set("repos", doc.createNode([entry.repo]));
  const text = doc.toString({ lineWidth: 0 });
  const loaded = loadConfig(text);
  return loaded.ok ? { ok: true, text, config: loaded.config } : { ok: false, problems: loaded.problems };
}

/** The first Target repo matching `which` that could run Stage `id`: any Pipeline has it, and a label may pick any Pipeline. */
function otherRepoRunning(config: FactoryConfig, id: string, which: (repo: TargetRepo) => boolean): string | undefined {
  const runsIt = Object.values(config.pipelines).some((p) => p.stages.includes(id));
  return runsIt ? config.repos.find(which)?.name : undefined;
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
