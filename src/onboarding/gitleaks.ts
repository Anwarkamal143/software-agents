import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** The gitleaks Pre-push checks scan every diff with. Keep `scripts/fetch-gitleaks.mjs` in step. */
export const GITLEAKS_VERSION = "8.30.1";

const exec = promisify(execFile);

export interface InstallGitleaksOptions {
  fetch?: (url: string) => Promise<Response>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where the release lives; GitHub's by default. */
  baseUrl?: string;
}

/**
 * Downloads the pinned gitleaks release for this OS to `dest` (ADR 0011), checked against the
 * release's published sha256 checksums. A mismatch installs nothing. Already there at the pinned
 * version: nothing to do. Returns whether it downloaded.
 */
export async function installGitleaks(dest: string, options: InstallGitleaksOptions = {}): Promise<boolean> {
  if (existsSync(dest) && (await gitleaksVersion(dest).catch(() => null)) === GITLEAKS_VERSION) return false;
  const platform = ({ darwin: "darwin", linux: "linux" } as Record<string, string>)[options.platform ?? process.platform];
  const arch = ({ arm64: "arm64", x64: "x64" } as Record<string, string>)[options.arch ?? process.arch];
  if (!platform || !arch) throw new Error(`gitleaks has no build for ${options.platform ?? process.platform}/${options.arch ?? process.arch}.`);
  const base = options.baseUrl ?? `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
  const asset = `gitleaks_${GITLEAKS_VERSION}_${platform}_${arch}.tar.gz`;
  const get = async (url: string) => {
    const res = await (options.fetch ?? ((u) => fetch(u)))(url);
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const sums = (await get(`${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`)).toString();
  const expected = sums.split("\n").find((l) => l.trim().endsWith(`  ${asset}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`${asset} isn't in the release checksums.`);
  const tarball = await get(`${base}/${asset}`);
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected) throw new Error(`${asset}: sha256 ${actual}, expected ${expected}. Not installing.`);

  // Extract in a fresh, empty folder and take only the binary out of it.
  const work = mkdtempSync(join(tmpdir(), "factory-gitleaks-"));
  try {
    writeFileSync(join(work, asset), tarball);
    await exec("tar", ["-xzf", join(work, asset), "-C", work, "gitleaks"]);
    mkdirSync(dirname(dest), { recursive: true });
    chmodSync(join(work, "gitleaks"), 0o755);
    renameSync(join(work, "gitleaks"), dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return true;
}

/** The version the gitleaks at `path` reports, such as `8.30.1`. */
export async function gitleaksVersion(path: string): Promise<string> {
  const { stdout } = await exec(path, ["version"], { env: { PATH: process.env.PATH ?? "" }, timeout: 10_000 });
  return stdout.trim().replace(/^v/, "");
}
