import { Ajv, type ValidateFunction } from "ajv";
import { CHECKPOINTS } from "../policies/checkpoint.js";

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
/** Where a Reply command came from: a GitHub comment (`by`, `comment_id`) or the local CLI. */
const reply = { channel: { enum: ["github", "cli"] }, by: str, comment_id: str };
/** For a version that only added optional fields: older data already fits. */
const sameData = (data: Record<string, unknown>) => data;

/** The v1 event types (Event schema and observability, #16, plus ADR 0010). */
export const V1_EVENTS: EventRegistry = {
  // Job
  "job-approved": {
    version: 1,
    // The approved issue text (untrusted) and labels, as the Source saw them at approval.
    data: obj({ repo: str, issue: { type: "integer", minimum: 1 } }, { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: str } }),
  },
  "job-reapproval-needed": { version: 1, data: obj({}, { editor: str }) },
  // The issue's title or body changed after approval. `allowed`: the editor is on `humans`, so the
  // edit counts as re-approval; otherwise it waits for a human's /approve (ADR 0007). The text is untrusted.
  "issue-edited": {
    version: 1,
    data: obj({ hash: str }, { by: str, title: { type: "string" }, body: { type: "string" }, allowed: { type: "boolean" } }),
  },
  // A human asked for a failed or cancelled Job's next Attempt (ADR 0010): by re-labelling the
  // issue, which carries its text as re-approved, or with `factory retry`.
  "job-retried": { version: 1, data: obj({}, { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: str } }) },
  "job-cancelled": { version: 1, data: obj({}, { reason: str }) },
  "attempt-started": { version: 1, data: obj({ branch: str }, { base: str }) },
  "job-failed": { version: 1, data: obj({ reason: str }) },
  // Stage run
  // `retry_of` is the stage-errored or stage-interrupted event this run retries (ADR 0010).
  "stage-started": { version: 2, data: obj(stage, { config_hash: str, retry_of: str }), upgrades: { 1: sameData } },
  "stage-passed": { version: 1, data: obj(stage, usage) },
  "stage-failed": { version: 1, data: obj(stage, { ...usage, summary: str }) },
  // `session_id` is the agent session to resume once a human answers.
  "stage-needs-human": { version: 2, data: obj(stage, { ...usage, question: str, options: { type: "array", items: str }, session_id: str }), upgrades: { 1: sameData } },
  "stage-skipped": { version: 1, data: obj({ ...stage, why: str }) },
  // The agent session a Stage run started, as soon as it is known, so a restart can resume it.
  "session-started": { version: 1, data: obj({ ...stage, session_id: str }) },
  // `session_id` is the broken agent session, which a retry may resume.
  "stage-errored": {
    version: 2,
    data: obj({ ...stage, reason: { enum: ["crash", "sdk-error", "invalid-result", "timeout", "budget"] } }, { ...usage, message: { type: "string" }, where: str, session_id: str }),
    upgrades: { 1: sameData },
  },
  // `reason` says what interrupted the run, such as a Factory fault; absent after a restart.
  // `session_id` is the agent session cut off, which a restart resumes once.
  "stage-interrupted": { version: 3, data: obj(stage, { reason: str, session_id: str }), upgrades: { 1: sameData, 2: sameData } },
  // The agent session `session_id` resumed with a human's answer (`answer`, the human-answered event),
  // or as a retry (`retry_of`).
  "stage-resumed": { version: 3, data: obj(stage, { session_id: str, answer: str, retry_of: str, config_hash: str }), upgrades: { 1: sameData, 2: sameData } },
  // A Bounce a human asked for carries `answer` (the human-answered event); a `/reject` also carries its reason as `finding`.
  // A Bounce from the Merge gate (`from: merge-gate`, a rebase conflict) carries its own `summary` and `findings`.
  bounced: {
    version: 3,
    data: obj(
      { from: str, to: str, bounce: { type: "integer", minimum: 1 } },
      {
        answer: str,
        finding: obj({ severity: str, message: str, root_cause: str }),
        summary: str,
        findings: { type: "array", items: obj({ severity: str, message: str, root_cause: str }, { file: str }) },
      },
    ),
    upgrades: { 1: sameData, 2: sameData },
  },
  // Evidence and Guards
  // The Orchestrator's own proof about `head`, such as a passing Check Stage's output. Only a pass is Evidence.
  "evidence-recorded": { version: 2, data: obj({ head: str, sha256: str, size: int }, { stage: str }), upgrades: { 1: sameData } },
  "guard-blocked": { version: 2, data: obj({ guard: str }, { tool: str, why: str }), upgrades: { 1: sameData } },
  "prepush-failed": {
    version: 1,
    data: obj({ check: str }, { failures: { type: "array", items: obj({ check: str, message: str }) } }),
  },
  // The Orchestrator pushed the Job branch from the Trusted clone after Pre-push checks passed.
  "branch-pushed": { version: 1, data: obj({ branch: str, before: str, head: str }) },
  // Policies
  // `outcome` is what the Checkpoint decided.
  "checkpoint-evaluated": { version: 2, data: obj({ checkpoint: { enum: CHECKPOINTS } }, { outcome: str, why: str }), upgrades: { 1: sameData } },
  // Spend is always an estimate.
  "budget-exceeded": {
    version: 2,
    data: obj({ budget: { enum: ["stage_run", "job", "daily"] } }, { checkpoint: { enum: CHECKPOINTS }, spent_usd: num, limit_usd: num, why: str }),
    upgrades: { 1: sameData },
  },
  // `status` is the rate limit's: rejected, or allowed_warning past 90% (`utilization`).
  "plan-limit-hit": { version: 2, data: obj({}, { resets_at: str, status: str, utilization: num }), upgrades: { 1: sameData } },
  "plan-limit-reset": { version: 1, data: obj() },
  // Humans
  "human-requested": {
    version: 2,
    // `cause` names why the Factory needs judgement, such as bounce-cap or repeated-root-cause;
    // `stage` is the Stage the Job was at. A question has the asking Stage's two or three options (A–C).
    data: obj({ kind: { enum: ["question", "approval"] } }, { text: str, options: { type: "array", items: str }, cause: str, stage: str, reject_to: str }),
    upgrades: { 1: sameData },
  },
  // `request` is the human-requested event answered; `text` is the chosen option's text, the
  // `other:` text or the `/reject` reason. Free text is data, never instructions (ADR 0006).
  "human-answered": {
    version: 2,
    data: obj({ command: { enum: ["answer", "approve", "reject", "cancel"] } }, { option: str, text: str, request: str, ...reply }),
    upgrades: { 1: sameData },
  },
  // A Reply command that wasn't accepted, and why. `already-answered` gets a reply saying so.
  "reply-ignored": { version: 2, data: obj({ why: str }, { command: str, request: str, detail: str, ...reply }), upgrades: { 1: sameData } },
  // One reminder per Human request, after three days of waiting.
  "human-reminded": { version: 2, data: obj({}, { request: str }), upgrades: { 1: sameData } },
  // A Mirror gave up on a write GitHub kept refusing (ADR 0002): `event_type` is what it was mirroring (`caused_by`).
  // Job state never depends on it; it says what GitHub may be missing.
  "mirror-write-dropped": { version: 1, data: obj({ mirror: str, event_type: str, why: str }) },
  // Merging
  "pr-opened": { version: 1, data: obj({ number: { type: "integer", minimum: 1 } }, { url: str }) },
  // The Merge gate rebased the Job branch from `before` onto the default branch at `base`, and pushed it as `head`.
  rebased: { version: 2, data: obj({ base: str }, { before: str, head: str }), upgrades: { 1: sameData } },
  "merge-gate-evaluated": {
    version: 2,
    data: obj({ passed: { type: "boolean" } }, { head: str, failures: { type: "array", items: obj({ code: str, why: str }) } }),
    upgrades: { 1: sameData },
  },
  "would-have-merged": { version: 1, data: obj({ would: { type: "boolean" } }, { why: str }) },
  // Merged by a human (`by`, actor `human:<login>`), or by the Factory (actor `orchestrator`) as the commit `sha`.
  "pr-merged": { version: 2, data: obj({}, { number: int, by: str, sha: str }), upgrades: { 1: sameData } },
  // Closed without merging: by a human (actor `human:<login>`), or by the Factory as a cancelled Job's ending.
  // An ending write GitHub refused outright says so in `refused`, and isn't tried again.
  "pr-closed": { version: 2, data: obj({}, { number: int, refused: str }), upgrades: { 1: sameData } },
  // A failed Job's PR, turned back into a draft by the Factory (ADR 0010).
  "pr-drafted": { version: 1, data: obj({ number: { type: "integer", minimum: 1 } }, { refused: str }) },
  // The Factory took the ready label off the issue: a cancelled or reverted Job's, so only re-labelling starts the next.
  "ready-label-removed": { version: 1, data: obj({ label: str }, { refused: str }) },
  // The Factory reopened the issue of a Job whose merge it reverted.
  "issue-reopened": { version: 1, data: obj({}, { refused: str }) },
  // The post-merge watch saw the default branch go red and opened `revert_pr`; `merged` if the Factory merged it (in auto).
  reverted: { version: 2, data: obj({}, { revert_pr: int, why: str, merged: { type: "boolean" } }), upgrades: { 1: sameData } },
  // Factory-wide
  "factory-started": { version: 1, data: obj() },
  "factory-stopped": { version: 1, data: obj() },
  // A Factory fault (ADR 0010) pauses with a `reason` such as sandbox-unavailable, and says what happened in `message`.
  "factory-paused": { version: 2, data: obj({}, { reason: str, message: str }), upgrades: { 1: sameData } },
  "factory-resumed": { version: 1, data: obj() },
  "config-reloaded": { version: 1, data: obj({ config_hash: str }) },
  // What one sweep deleted (ADR 0010): counts, and the branches it deleted, so none is tried twice.
  "housekeeping-ran": {
    version: 2,
    data: obj({}, { working_copies: int, transcripts: int, artifacts: int, branches_deleted: { type: "array", items: obj({ job_id: str, branch: str }) } }),
    upgrades: { 1: sameData },
  },
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
