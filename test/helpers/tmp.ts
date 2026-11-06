import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fresh Factory home for one test, removed afterwards. */
export function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-test-"));
  dirs.push(dir);
  return dir;
}
