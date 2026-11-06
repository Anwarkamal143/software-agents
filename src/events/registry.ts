import { Ajv, type ValidateFunction } from "ajv";

/**
 * Every event type has a schema for its `data` at its current version, plus
 * upgraders that lift older stored versions to the current one on read (ADR 0009).
 */
export interface EventTypeSpec {
  /** Current schema version. Writers always write this version. */
  version: number;
  /** JSON Schema for `data` at `version`. */
  data: object;
  /** `upgrades[n]` turns version-n data into version n+1 data. */
  upgrades?: Record<number, (data: Record<string, unknown>) => Record<string, unknown>>;
}

export type EventRegistry = Record<string, EventTypeSpec>;

const obj = (required: Record<string, object> = {}, optional: Record<string, object> = {}) => ({
  type: "object",
  required: Object.keys(required),
  properties: { ...required, ...optional },
});
const str = { type: "string", minLength: 1 };
const int = { type: "integer", minimum: 0 };
const num = { type: "number", minimum: 0 };
/** Cost, tokens, turns and duration ride on Stage-ending events. Cost is always estimated. */
const usage = { cost_usd: num, tokens: int, turns: int, duration_ms: int };
const stage = { stage: str };

/** The v1 event types (Event schema and observability, #16, plus ADR 0010). */
export const V1_EVENTS: EventRegistry = {
  // Job
  "job-approved": {
    version: 1,
    // The approved issue text (untrusted) and labels, as the Source saw them at approval.
    data: obj({ repo: str, issue: { type: "integer", minimum: 1 } }, { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: str } }),
  },
  "job-reapproval-needed": { version: 1, data: obj({}, { editor: str }) },
  "job-cancelled": { version: 1, data: obj({}, { reason: str }) },
  "attempt-started": { version: 1, data: obj({ branch: str }, { base: str }) },
  "job-failed": { version: 1, data: obj({ reason: str }) },
  // Stage run
  "stage-started": { version: 1, data: obj(stage, { config_hash: str }) },
  "stage-passed": { version: 1, data: obj(stage, usage) },
  "stage-failed": { version: 1, data: obj(stage, { ...usage, summary: str }) },
  "stage-needs-human": { version: 1, data: obj(stage, { ...usage, question: str, options: { type: "array", items: str } }) },
  "stage-skipped": { version: 1, data: obj({ ...stage, why: str }) },
  "stage-errored": {
    version: 1,
    data: obj({ ...stage, reason: { enum: ["crash", "sdk-error", "invalid-result", "timeout", "budget"] } }, usage),
  },
  "stage-interrupted": { version: 1, data: obj(stage) },
  "stage-resumed": { version: 1, data: obj(stage) },
  bounced: { version: 1, data: obj({ from: str, to: str, bounce: { type: "integer", minimum: 1 } }) },
  // Evidence and Guards
  "evidence-recorded": { version: 1, data: obj({ head: str, sha256: str, size: int }) },
  "guard-blocked": { version: 1, data: obj({ guard: str }, { tool: str }) },
  "prepush-failed": {
    version: 1,
    data: obj({ check: str }, { failures: { type: "array", items: obj({ check: str, message: str }) } }),
  },
  // The Orchestrator pushed the Job branch from the Trusted clone after Pre-push checks passed.
  "branch-pushed": { version: 1, data: obj({ branch: str, before: str, head: str }) },
  // Policies
  "checkpoint-evaluated": { version: 1, data: obj({ checkpoint: str }) },
  "budget-exceeded": { version: 1, data: obj({ budget: { enum: ["stage_run", "job", "daily"] } }) },
  "plan-limit-hit": { version: 1, data: obj({}, { resets_at: str }) },
  "plan-limit-reset": { version: 1, data: obj() },
  // Humans
  "human-requested": {
    version: 1,
    // `cause` names why the Factory needs judgement, such as bounce-cap or repeated-root-cause.
    data: obj({ kind: { enum: ["question", "approval"] } }, { text: str, options: { type: "array", items: str }, cause: str }),
  },
  "human-answered": { version: 1, data: obj({ command: { enum: ["answer", "approve", "reject", "cancel"] } }, { option: str }) },
  "reply-ignored": { version: 1, data: obj({ why: str }) },
  "human-reminded": { version: 1, data: obj() },
  // Merging
  "pr-opened": { version: 1, data: obj({ number: { type: "integer", minimum: 1 } }, { url: str }) },
  rebased: { version: 1, data: obj({ base: str }) },
  "merge-gate-evaluated": { version: 1, data: obj({ passed: { type: "boolean" } }) },
  "would-have-merged": { version: 1, data: obj({ would: { type: "boolean" } }, { why: str }) },
  "pr-merged": { version: 1, data: obj({}, { number: int, by: str }) },
  "pr-closed": { version: 1, data: obj({}, { number: int }) },
  reverted: { version: 1, data: obj({}, { revert_pr: int, why: str }) },
  // Factory-wide
  "factory-started": { version: 1, data: obj() },
  "factory-stopped": { version: 1, data: obj() },
  "factory-paused": { version: 1, data: obj({}, { reason: str }) },
  "factory-resumed": { version: 1, data: obj() },
  "config-reloaded": { version: 1, data: obj({ config_hash: str }) },
  "housekeeping-ran": { version: 1, data: obj() },
  // Bookkeeping
  "transition-rejected": {
    version: 1,
    data: obj({ rejected_type: str, from_status: str, why: str }, { rejected_data: { type: "object" } }),
  },
};

/** Validators and upgrade-on-read for one registry. */
export class EventTypes {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(readonly registry: EventRegistry = V1_EVENTS) {
    const ajv = new Ajv({ allErrors: true });
    for (const [type, spec] of Object.entries(registry)) this.validators.set(type, ajv.compile(spec.data));
  }

  knows(type: string): boolean {
    return type in this.registry;
  }

  currentVersion(type: string): number {
    const spec = this.registry[type];
    if (!spec) throw new Error(`Unknown event type "${type}".`);
    return spec.version;
  }

  /** Throws if `data` doesn't fit the current schema of `type`. */
  check(type: string, data: unknown): void {
    const validate = this.validators.get(type);
    if (!validate) throw new Error(`Unknown event type "${type}".`);
    if (!validate(data)) {
      const why = (validate.errors ?? []).map((e) => `${e.instancePath || "data"} ${e.message}`).join("; ");
      throw new Error(`Invalid "${type}" event: ${why}.`);
    }
  }

  /** Lifts stored data to the current version. Returns null for an unknown type. */
  upgrade(type: string, version: number, data: Record<string, unknown>) {
    const spec = this.registry[type];
    if (!spec) return null;
    let d = data;
    for (let v = version; v < spec.version; v++) {
      const up = spec.upgrades?.[v];
      if (!up) throw new Error(`No upgrade for "${type}" from schema_version ${v}.`);
      d = up(d);
    }
    return { version: spec.version, data: d };
  }
}
