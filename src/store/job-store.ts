import type { FactoryEvent, NewEvent } from "../events/envelope.js";

export interface FollowOptions {
  /** Stops the iterator. */
  signal?: AbortSignal;
  /** How often to look for events written by another process. Default 500ms. */
  pollMs?: number;
}

/**
 * The single authoritative home of the Event log (ADR 0002). SQLite is the v1
 * implementation; Postgres can sit behind the same interface later.
 */
export interface JobStore {
  /**
   * Appends one event and returns it as stored. An event whose `id` is already in
   * the log is not written again; the stored original is returned instead.
   */
  append(event: NewEvent): FactoryEvent;
  /** The stored event with this id, upgraded like `read`, if it exists and its type is known. */
  get(id: string): FactoryEvent | undefined;
  /**
   * Events with `seq >= fromSeq`, in seq order, upgraded to their current
   * schema version. Event types this Factory doesn't know are skipped.
   */
  read(fromSeq?: number, limit?: number): FactoryEvent[];
  /** Like `read`, then keeps delivering events as they are appended, until aborted. */
  follow(fromSeq?: number, options?: FollowOptions): AsyncIterable<FactoryEvent>;
  close(): void;
}
