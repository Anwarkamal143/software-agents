import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homePaths } from "../home.js";

/** Points at exact bytes: Evidence and events refer to large outputs this way (ADR 0009). */
export interface ArtifactRef {
  sha256: string;
  size: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Large outputs (check logs, diffs, Stage result artifacts) as sha256-named
 * files under `<Factory home>/artifacts`, mode 600.
 */
export class ArtifactStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = homePaths(home).artifacts;
  }

  put(bytes: string | Uint8Array): ArtifactRef {
    const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const file = this.path(sha256);
    if (!existsSync(file)) {
      mkdirSync(join(this.dir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, buf, { mode: 0o600 });
      renameSync(tmp, file);
    }
    return { sha256, size: buf.length };
  }

  get(sha256: string): Buffer {
    return readFileSync(this.path(sha256));
  }

  path(sha256: string): string {
    if (!SHA256.test(sha256)) throw new Error(`"${sha256}" is not a sha256 hash.`);
    return join(this.dir, sha256.slice(0, 2), sha256);
  }
}
