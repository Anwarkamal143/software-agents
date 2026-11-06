import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ulid } from "ulid";
import type { FactoryEvent, NewEvent } from "../events/envelope.js";
import { EventTypes, type EventRegistry } from "../events/registry.js";
import type { FollowOptions, JobStore } from "./job-store.js";

interface Row {
  seq: number;
  id: string;
  type: string;
  schema_version: number;
  at: string;
  job_id: string | null;
  attempt: number | null;
  stage_run_id: string | null;
  actor: string;
  caused_by: string | null;
  data: string;
}

export interface SqliteJobStoreOptions {
  /** Event types this Factory knows. Defaults to the v1 types. */
  registry?: EventRegistry;
}

/** Opens (creating if needed) the SQLite Job store at `path`. */
export function openSqliteJobStore(path: string, options: SqliteJobStoreOptions = {}): JobStore {
  return new SqliteJobStore(path, new EventTypes(options.registry));
}

class SqliteJobStore implements JobStore {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly byId: StatementSync;
  private readonly from: StatementSync;
  private readonly wakers = new Set<() => void>();

  constructor(
    path: string,
    private readonly types: EventTypes,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        id             TEXT NOT NULL UNIQUE,
        type           TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        at             TEXT NOT NULL,
        job_id         TEXT,
        attempt        INTEGER,
        stage_run_id   TEXT,
        actor          TEXT NOT NULL,
        caused_by      TEXT,
        data           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_job ON events (job_id, seq);
      -- The Event log is append-only: events are never rewritten (ADR 0009).
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'the Event log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'the Event log is append-only'); END;
    `);
    this.insert = this.db.prepare(`
      INSERT INTO events (id, type, schema_version, at, job_id, attempt, stage_run_id, actor, caused_by, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`);
    this.byId = this.db.prepare(`SELECT * FROM events WHERE id = ?`);
    this.from = this.db.prepare(`SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT ?`);
  }

  append(event: NewEvent): FactoryEvent {
    const data = event.data ?? {};
    const version = event.schema_version ?? this.types.currentVersion(event.type);
    if (version === this.types.currentVersion(event.type)) this.types.check(event.type, data);
    const id = event.id ?? ulid();
    const result = this.insert.run(
      id,
      event.type,
      version,
      event.at ?? new Date().toISOString(),
      event.job_id ?? null,
      event.attempt ?? null,
      event.stage_run_id ?? null,
      event.actor,
      event.caused_by ?? null,
      JSON.stringify(data),
    );
    if (result.changes > 0) for (const wake of this.wakers) wake();
    return this.decode(this.byId.get(id) as unknown as Row, false)!;
  }

  read(fromSeq = 1, limit = Number.MAX_SAFE_INTEGER): FactoryEvent[] {
    const out: FactoryEvent[] = [];
    // Unknown types are skipped, so page through until `limit` known events are found.
    let cursor = fromSeq;
    while (out.length < limit) {
      const rows = this.from.all(cursor, Math.min(limit - out.length, 1000)) as unknown as Row[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = this.decode(row, true);
        if (event) out.push(event);
      }
      cursor = rows[rows.length - 1]!.seq + 1;
    }
    return out;
  }

  async *follow(fromSeq = 1, { signal, pollMs = 500 }: FollowOptions = {}): AsyncIterable<FactoryEvent> {
    let cursor = fromSeq;
    while (!signal?.aborted) {
      const batch = this.read(cursor, 1000);
      for (const event of batch) {
        yield event;
        cursor = event.seq + 1;
      }
      if (batch.length === 0) {
        // Skipped (unknown) rows still move the cursor on.
        const last = this.db.prepare(`SELECT max(seq) AS seq FROM events`).get() as { seq: number | null };
        if (last.seq !== null && last.seq >= cursor) cursor = last.seq + 1;
        await this.waitForAppend(pollMs, signal);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private waitForAppend(pollMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      this.wakers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private decode(row: Row, upgrade: boolean): FactoryEvent | null {
    let version = row.schema_version;
    let data = JSON.parse(row.data) as Record<string, unknown>;
    if (upgrade) {
      const lifted = this.types.upgrade(row.type, version, data);
      if (!lifted) return null;
      ({ version, data } = lifted);
    }
    return {
      id: row.id,
      seq: row.seq,
      type: row.type,
      schema_version: version,
      at: row.at,
      job_id: row.job_id,
      attempt: row.attempt,
      stage_run_id: row.stage_run_id,
      actor: row.actor as FactoryEvent["actor"],
      caused_by: row.caused_by,
      data,
    };
  }
}
