/** What `factory repo add` proposes for a Target repo, for you to confirm or edit (ADR 0011). */
export interface Proposal {
  /** Check Stages by name, each with the commands it runs: the repo's `commands` lists. */
  checks: Record<string, string[]>;
  /** Hosts those commands need: the repo's network allowlist. */
  network: string[];
}

/** A file at the top of the repo's default branch, or null if there isn't one. */
export type ReadRepoFile = (path: string) => string | null;

/** Check Stages the Factory proposes, in Pipeline order. */
export const PROPOSED_CHECKS = ["test", "lint", "typecheck"] as const;

const NPM_PLACEHOLDER = /no test specified/;

/**
 * Check Stages and network allowlist entries from what's in the repo: `package.json` scripts and
 * its lockfile, `go.mod` or `Cargo.toml`. Each Check Stage runs in a clean checkout, so a Node
 * check installs dependencies first. Nothing here is written anywhere until you confirm it.
 */
export function proposeRepo(read: ReadRepoFile): Proposal {
  const checks: Record<string, string[]> = {};
  const network: string[] = [];
  const add = (hosts: string[]) => network.push(...hosts.filter((h) => !network.includes(h)));

  const pkgText = read("package.json");
  if (pkgText !== null) {
    const scripts = parseScripts(pkgText);
    const pm =
      read("pnpm-lock.yaml") !== null
        ? { install: "pnpm install --frozen-lockfile", run: (s: string) => (s === "test" ? "pnpm test" : `pnpm run ${s}`), hosts: ["registry.npmjs.org"] }
        : read("yarn.lock") !== null
          ? { install: "yarn install --frozen-lockfile", run: (s: string) => (s === "test" ? "yarn test" : `yarn run ${s}`), hosts: ["registry.yarnpkg.com", "registry.npmjs.org"] }
          : { install: read("package-lock.json") !== null ? "npm ci" : "npm install", run: (s: string) => (s === "test" ? "npm test" : `npm run ${s}`), hosts: ["registry.npmjs.org"] };
    const scriptFor: Record<(typeof PROPOSED_CHECKS)[number], string | undefined> = {
      test: scripts.test && !NPM_PLACEHOLDER.test(scripts.test) ? "test" : undefined,
      lint: scripts.lint ? "lint" : undefined,
      typecheck: ["typecheck", "type-check", "tsc"].find((s) => scripts[s]),
    };
    for (const check of PROPOSED_CHECKS) {
      const script = scriptFor[check];
      if (script) checks[check] = [pm.install, pm.run(script)];
    }
    add(pm.hosts);
  } else if (read("go.mod") !== null) {
    checks.test = ["go test ./..."];
    checks.lint = ["go vet ./..."];
    add(["proxy.golang.org", "sum.golang.org"]);
  } else if (read("Cargo.toml") !== null) {
    checks.test = ["cargo test"];
    checks.typecheck = ["cargo check"];
    add(["index.crates.io", "static.crates.io"]);
  }
  return { checks, network };
}

function parseScripts(text: string): Record<string, string> {
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object") return {};
    return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}
