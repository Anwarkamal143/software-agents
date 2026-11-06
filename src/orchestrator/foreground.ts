import { acquireLock } from "./lock.js";
import { JobStoreUnwritable } from "./orchestrator.js";

/** What the foreground loop drives: the Orchestrator. */
export interface FactoryLoop {
  start(): Promise<void>;
  runUntilIdle(): Promise<void>;
  poll(): Promise<void>;
  stop(): void;
}

export interface RunOptions {
  home: string;
  loop: FactoryLoop;
  /** One housekeeping sweep (ADR 0010). */
  housekeeping: () => Promise<unknown>;
  /** How often the Source is polled. Default 60s (ADR 0006). */
  pollMs?: number;
  /** How often housekeeping sweeps. Default hourly. */
  housekeepingMs?: number;
  /** Stops the Factory: sessions are cut off and resume at the next start. */
  signal: AbortSignal;
  /** Where errors that don't stop the Factory are told. */
  report?: (message: string) => void;
}

/**
 * `factory run`, the foreground Orchestrator (ADR 0001): one per Factory home, held by the lock.
 * At startup it replays the Event log and interrupts unfinished Stage runs, then sweeps; after
 * that it keeps Jobs moving, polls the Source every minute even while Stage runs go on, and
 * sweeps hourly. Only an unwritable Job store stops it (ADR 0010).
 */
export async function runFactory({ home, loop, housekeeping, pollMs = 60_000, housekeepingMs = 60 * 60_000, signal, report = () => {} }: RunOptions): Promise<void> {
  const lock = acquireLock(home);
  const told = (err: unknown) => report(err instanceof Error ? err.message : String(err));
  const fatal = (err: unknown) => {
    if (err instanceof JobStoreUnwritable) throw err;
    told(err);
  };
  try {
    await loop.start();
    await housekeeping().catch(fatal);
    let nextSweep = Date.now() + housekeepingMs;
    while (!signal.aborted) {
      const ticker = setInterval(() => void loop.poll().catch(told), pollMs);
      try {
        await Promise.race([loop.runUntilIdle(), aborted(signal)]);
      } catch (err) {
        fatal(err);
      } finally {
        clearInterval(ticker);
      }
      if (signal.aborted) break;
      if (Date.now() >= nextSweep) {
        await housekeeping().catch(fatal);
        nextSweep = Date.now() + housekeepingMs;
      }
      await wait(pollMs, signal);
    }
  } finally {
    loop.stop();
    lock.release();
  }
}

const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
