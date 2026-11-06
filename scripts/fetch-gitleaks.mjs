#!/usr/bin/env node
// Downloads the pinned gitleaks release for this OS into .tools/, verified against
// the release's published checksums. Pre-push checks run it on every pushed diff.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const GITLEAKS_VERSION = "8.30.1";
const root = new URL("..", import.meta.url).pathname;
const dest = join(root, ".tools", `gitleaks-${GITLEAKS_VERSION}`, "gitleaks");

const platform = { darwin: "darwin", linux: "linux" }[process.platform];
const arch = { arm64: "arm64", x64: "x64" }[process.arch];
if (!platform || !arch) throw new Error(`No gitleaks build for ${process.platform}/${process.arch}.`);

if (existsSync(dest)) {
  console.log(dest);
  process.exit(0);
}

const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
const asset = `gitleaks_${GITLEAKS_VERSION}_${platform}_${arch}.tar.gz`;
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const sums = (await get(`${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`)).toString();
const expected = sums.split("\n").find((l) => l.endsWith(`  ${asset}`))?.split(/\s+/)[0];
if (!expected) throw new Error(`${asset} isn't in the release checksums.`);
const tarball = await get(`${base}/${asset}`);
const actual = createHash("sha256").update(tarball).digest("hex");
if (actual !== expected) throw new Error(`${asset}: sha256 ${actual}, expected ${expected}. Not installing.`);

// Extract in a fresh, empty directory and take only the binary out of it.
const work = mkdtempSync(join(tmpdir(), "gitleaks-"));
try {
  writeFileSync(join(work, asset), tarball);
  execFileSync("tar", ["-xzf", join(work, asset), "-C", work, "gitleaks"]);
  mkdirSync(join(dest, ".."), { recursive: true });
  renameSync(join(work, "gitleaks"), dest);
  chmodSync(dest, 0o755);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(dest);
