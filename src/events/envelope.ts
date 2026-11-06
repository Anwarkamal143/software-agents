/**
 * The Event log envelope (ADR 0009). Every entry is a fact whose `type` is its cause.
 */

/** `orchestrator`, `stage:<name>`, `human:<login>` or `cli`. */
export type Actor = "orchestrator" | "cli" | `stage:${string}` | `human:${string}`;

export interface FactoryEvent<D = Record<string, unknown>> {
  /** ULID, unique across the log. Appending an existing id has no effect. */
  id: string;
  /** Global, gap-free read cursor, starting at 1. */
  seq: number;
  type: string;
  /** Per-type version; readers upgrade old versions as they read. */
  schema_version: number;
  /** ISO-8601 timestamp. */
  at: string;
  /** Null for Factory-wide events. */
  job_id: string | null;
  attempt: number | null;
  stage_run_id: string | null;
  actor: Actor;
  /** Id of the event that triggered this one, if any. */
  caused_by: string | null;
  data: D;
}

/** What a writer hands the Job store: the store assigns `seq`, and `id` / `at` when absent. */
export interface NewEvent<D = Record<string, unknown>> {
  id?: string;
  type: string;
  schema_version?: number;
  at?: string;
  job_id?: string | null;
  attempt?: number | null;
  stage_run_id?: string | null;
  actor: Actor;
  caused_by?: string | null;
  data?: D;
}
