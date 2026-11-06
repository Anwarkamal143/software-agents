import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Another Orchestrator holds the lock: only one may run per Factory home (ADR 0010). */
export class LockHeld extends Error {
  override name = "LockHeld";
}

export interface Lock {
  release(): void;
}

/**
 * Takes the Factory home's Orchestrator lock: a file holding the owner's pid. A lock whose
 * owner is no longer running is stale and taken over.
 */
export function acquireLock(home: string): Lock {
  const path = join(home, "orchestrator.lock");
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => unlinkSync(path) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || tries > 0) throw err;
    }
    const pid = Number.parseInt(readText(path), 10);
    if (Number.isInteger(pid) && alive(pid)) throw new LockHeld(`Another Orchestrator (pid ${pid}) is running for this Factory home; stop it first.`);
    unlinkSync(path);
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
