import { existsSync } from "node:fs";

/** The pinned gitleaks fetched by `npm run fetch:gitleaks`. Tests fail, never skip, without it. */
export function gitleaksPath(): string {
  const path = new URL("../../.tools/gitleaks-8.30.1/gitleaks", import.meta.url).pathname;
  if (!existsSync(path)) throw new Error(`gitleaks isn't at ${path}. Run \`npm run fetch:gitleaks\` first.`);
  return path;
}
