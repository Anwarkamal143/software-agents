import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { homePaths } from "../home.js";

/** Values shorter than this are never treated as secrets: redacting them would mangle ordinary text. */
const MIN_SECRET_LENGTH = 6;

/**
 * Transcripts (ADR 0009): the raw messages of each Stage run's agent session, one NDJSON file
 * per run under `<Factory home>/transcripts/<job>/`, mode 600. Events point at them by Stage run
 * id; Job state never depends on them, and they never go to a Mirror.
 */
export class Transcripts {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = homePaths(home).transcripts;
  }

  path(job_id: string, stage_run_id: string): string {
    return join(this.dir, safe(job_id), `${safe(stage_run_id)}.ndjson`);
  }

  /** Starts a Stage run's Transcript. `secrets` are the exact values to replace, by name, before anything is written. */
  open(job_id: string, stage_run_id: string, secrets: Record<string, string>): Transcript {
    mkdirSync(join(this.dir, safe(job_id)), { recursive: true, mode: 0o700 });
    return new Transcript(this.path(job_id, stage_run_id), secrets);
  }
}

export class Transcript {
  private readonly fd: number;
  private readonly redactions: [string, string][];

  constructor(path: string, secrets: Record<string, string>) {
    this.fd = openSync(path, "a", 0o600);
    // Each value as it appears raw and as JSON escapes it; longest first, so one secret
    // containing another is replaced whole.
    this.redactions = Object.entries(secrets)
      .filter(([, value]) => value.length >= MIN_SECRET_LENGTH)
      .flatMap(([name, value]): [string, string][] => {
        const escaped = JSON.stringify(value).slice(1, -1);
        return escaped === value ? [[value, name]] : [[value, name], [escaped, name]];
      })
      .sort((a, b) => b[0].length - a[0].length);
  }

  /** Appends one message, with every secret value replaced by `[redacted:<name>]`. */
  write(message: unknown): void {
    let line = JSON.stringify(message);
    for (const [value, name] of this.redactions) line = line.split(value).join(`[redacted:${name}]`);
    appendFileSync(this.fd, `${line}\n`);
  }

  async close(): Promise<void> {
    closeSync(this.fd);
  }
}

/** Ids name files: nothing that could climb out of the Transcripts folder. */
const safe = (id: string) => id.replace(/[^\w-]/g, "_");
