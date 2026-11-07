import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITLEAKS_VERSION, gitleaksVersion, installGitleaks } from "../src/onboarding/gitleaks.js";
import { tmpHome } from "./helpers/tmp.js";

const ASSET = `gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz`;

/** A release with a stand-in gitleaks that prints `version`, and its checksums file. */
function release(version = GITLEAKS_VERSION, { badSum = false } = {}) {
  const dir = join(tmpHome(), "release");
  mkdirSync(dir);
  writeFileSync(join(dir, "gitleaks"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  execFileSync("tar", ["-czf", join(dir, ASSET), "-C", dir, "gitleaks"]);
  const tarball = readFileSync(join(dir, ASSET));
  const sum = badSum ? "0".repeat(64) : createHash("sha256").update(tarball).digest("hex");
  const files: Record<string, Buffer> = { [`gitleaks_${GITLEAKS_VERSION}_checksums.txt`]: Buffer.from(`${sum}  ${ASSET}\n`), [ASSET]: tarball };
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const body = files[url.split("/").at(-1)!];
    return body ? new Response(body) : new Response("not found", { status: 404 });
  };
  return { fetch, requested };
}

describe("installGitleaks", () => {
  test("installs the pinned release once its sha256 matches the release checksums", async () => {
    const dest = join(tmpHome(), "tools", "gitleaks");
    const r = release();

    expect(await installGitleaks(dest, { fetch: r.fetch, platform: "darwin", arch: "arm64", baseUrl: "https://example.test" })).toBe(true);

    expect(await gitleaksVersion(dest)).toBe(GITLEAKS_VERSION);
    // Already there at the pinned version: nothing downloaded again.
    expect(await installGitleaks(dest, { fetch: r.fetch, platform: "darwin", arch: "arm64", baseUrl: "https://example.test" })).toBe(false);
    expect(r.requested).toHaveLength(2);
  });

  test("a checksum mismatch installs nothing", async () => {
    const dest = join(tmpHome(), "tools", "gitleaks");
    await expect(installGitleaks(dest, { fetch: release(GITLEAKS_VERSION, { badSum: true }).fetch, platform: "darwin", arch: "arm64", baseUrl: "https://example.test" })).rejects.toThrow(/Not installing/);
    expect(existsSync(dest)).toBe(false);
  });

  test("the pin matches the one the test suite fetches", () => {
    const script = readFileSync(new URL("../scripts/fetch-gitleaks.mjs", import.meta.url), "utf8");
    expect(script).toContain(`GITLEAKS_VERSION = "${GITLEAKS_VERSION}"`);
  });
});
