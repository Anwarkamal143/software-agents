/** The shape of `~/.factory/factory.yaml` (ADR 0005). `schema/factory.schema.json` is the published form. */

export type Autonomy = "off" | "trial" | "auto";
export type ToolProfile = "read-only" | "write-branch";
/** How the Factory merges a PR: GitHub's three ways. */
export type MergeMethod = "squash" | "merge" | "rebase";

export interface RiskRule {
  name: string;
  labels?: string[];
  paths?: string[];
  keywords?: string[];
}

export interface Budgets {
  /** Hard, per Stage run. */
  stage_run: { usd: number; turns: number; minutes: number };
  /** Soft, checked before each Stage run. */
  job: { usd: number };
  /** Soft, Factory-wide. A Factory-wide value: only the Factory layer may set it. */
  daily: { usd: number };
}

export interface Policies {
  autonomy: Autonomy;
  bounce_cap: number;
  size_cap: number;
  post_merge_watch_minutes: number;
  budgets: Budgets;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** What a Pipeline or a label may set: tighten-only. */
export type PolicyPatch = DeepPartial<Policies>;

/** What the Factory or a Target repo may set: it may loosen, and add or switch off Risk rules. */
export interface OwnerPolicyPatch extends PolicyPatch {
  risk_rules?: RiskRule[];
  /** Switch earlier layers' Risk rules off by name. */
  risk_rules_off?: string[];
}

/** Run the Stage only if the Job has any of `labels`, or the Attempt changed a file matching any of `paths`. */
export interface StageCondition {
  labels?: string[];
  paths?: string[];
}

export interface AgentStage {
  kind: "agent";
  instructions: string;
  tools: ToolProfile;
  model?: string;
  /** The earlier Stage a fail Verdict Bounces to. */
  on_fail?: string;
  when?: StageCondition;
}

export interface CheckStage {
  kind: "check";
  /** Which of the Target repo's `commands` lists to run. */
  run: string;
  on_fail?: string;
  when?: StageCondition;
}

export type Stage = AgentStage | CheckStage;

export interface Pipeline {
  stages: string[];
  policies?: PolicyPatch;
}

export interface TargetRepo {
  /** `owner/repo` */
  name: string;
  default_pipeline: string;
  commands?: Record<string, string[]>;
  /** Domains this repo's Check Stages, and Tool profiles that enable network, may reach from the Sandbox. */
  network?: string[];
  /** Names of this repo's check secrets, set with `factory secret set` and kept in the keychain per repo. Each Check Stage gets them as env vars of the same name. */
  check_secrets?: string[];
  max_running?: number;
  /** How the Factory merges this repo's PRs. Default squash. */
  merge_method?: MergeMethod;
  policies?: OwnerPolicyPatch & { budgets?: PolicyPatch["budgets"] };
  /** A repo may change only `model` and `instructions` of a library Stage. */
  stage_overrides?: Record<string, { model?: string; instructions?: string }>;
  agent?: { model?: string; auth?: string };
  /** Present only so `factory config check` can name it: the Job store and Mirrors are Factory-wide. */
  state?: unknown;
}

export interface FactoryConfig {
  version: 1;
  /** GitHub logins allowed to approve Jobs and send Reply commands. */
  humans: string[];
  /** Factory-wide cap on concurrent Stage runs. */
  max_running: number;
  agent: {
    adapter: "claude";
    auth: "api-key" | "subscription";
    model: string;
    /** `${env:NAME}` or `keychain:NAME`, never the key itself. */
    api_key?: string;
  };
  state: {
    store: "sqlite" | "postgres";
    mirrors: "github"[];
    /** `${env:NAME}` or `keychain:NAME`. */
    postgres_url?: string;
  };
  sources: { kind: "github-issues"; ready_label: string }[];
  policies: OwnerPolicyPatch;
  stages: Record<string, Stage>;
  pipelines: Record<string, Pipeline>;
  repos: TargetRepo[];
  label_overrides: Record<string, PolicyPatch>;
}
