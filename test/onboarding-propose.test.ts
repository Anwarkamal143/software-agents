import { describe, expect, test } from "vitest";
import { proposeRepo } from "../src/onboarding/propose.js";

const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "web-app", scripts });

describe("proposeRepo", () => {
  test("a Node repo with test, lint and typecheck scripts and an npm lockfile", () => {
    const proposal = proposeRepo(files({ "package.json": pkg({ test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", dev: "vite" }), "package-lock.json": "{}" }));
    expect(proposal).toEqual({
      checks: {
        test: ["npm ci", "npm test"],
        lint: ["npm ci", "npm run lint"],
        typecheck: ["npm ci", "npm run typecheck"],
      },
      network: ["registry.npmjs.org"],
    });
  });

  test("uses the package manager its lockfile names, and a type-check script by its own name", () => {
    expect(proposeRepo(files({ "package.json": pkg({ test: "jest", "type-check": "tsc" }), "pnpm-lock.yaml": "" }))).toEqual({
      checks: { test: ["pnpm install --frozen-lockfile", "pnpm test"], typecheck: ["pnpm install --frozen-lockfile", "pnpm run type-check"] },
      network: ["registry.npmjs.org"],
    });
    expect(proposeRepo(files({ "package.json": pkg({ lint: "eslint ." }), "yarn.lock": "" }))).toEqual({
      checks: { lint: ["yarn install --frozen-lockfile", "yarn run lint"] },
      network: ["registry.yarnpkg.com", "registry.npmjs.org"],
    });
  });

  test("npm's placeholder test script isn't a test", () => {
    expect(proposeRepo(files({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) })).checks).toEqual({});
  });

  test("Go and Rust repos", () => {
    expect(proposeRepo(files({ "go.mod": "module x" }))).toEqual({
      checks: { test: ["go test ./..."], lint: ["go vet ./..."] },
      network: ["proxy.golang.org", "sum.golang.org"],
    });
    expect(proposeRepo(files({ "Cargo.toml": "[package]" }))).toEqual({
      checks: { test: ["cargo test"], typecheck: ["cargo check"] },
      network: ["index.crates.io", "static.crates.io"],
    });
  });

  test("a repo with nothing it recognises gets nothing proposed", () => {
    expect(proposeRepo(files({ "README.md": "# hi" }))).toEqual({ checks: {}, network: [] });
  });
});
