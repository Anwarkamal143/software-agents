import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One saved write, and which of its parts have already been delivered. */
export interface OutboxEntry<T> {
  item: T;
  /** Parts of the write delivered so far, so a retry never repeats one. */
  done: string[];
  /** Times delivery was refused outright (not just unreachable). */
  refusals: number;
}

/**
 * A first-in, first-out queue on disk (ADR 0002): every write is saved before anything is sent,
 * one file per entry, so a restart carries on where delivery stopped.
 */
export class Outbox<T> {
  private next: number;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.next = Math.max(0, ...this.names().map((n) => Number.parseInt(n, 10))) + 1;
  }

  /** Saves a write at the back of the queue. */
  add(item: T): void {
    const name = `${String(this.next++).padStart(16, "0")}.json`;
    this.save(name, { item, done: [], refusals: 0 });
  }

  /** The oldest readable entry, or null when the queue is empty. One that can't be read is set aside, so it never holds up the rest. */
  head(): { name: string; entry: OutboxEntry<T> } | null {
    for (const name of this.names()) {
      const entry = readJson<OutboxEntry<T>>(join(this.dir, name));
      if (entry) return { name, entry };
    }
    return null;
  }

  /** Saves an entry's progress. */
  save(name: string, entry: OutboxEntry<T>): void {
    writeAtomic(join(this.dir, name), JSON.stringify(entry));
  }

  /** Takes a delivered (or dropped) entry off the queue. */
  remove(name: string): void {
    rmSync(join(this.dir, name), { force: true });
  }

  /** Entries not yet delivered. */
  size(): number {
    return this.names().length;
  }

  private names(): string[] {
    return readdirSync(this.dir)
      .filter((n) => /^\d{16}\.json$/.test(n))
      .sort();
  }
}

/** Written whole or not at all: a crash leaves the old file or the new one, never half of either. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** A JSON file's contents, or null if it is missing. One that can't be parsed is renamed `.unreadable` and kept for a look. */
export function readJson<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    renameSync(path, `${path}.unreadable`);
    return null;
  }
}
