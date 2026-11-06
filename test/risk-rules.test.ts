import { describe, expect, test } from "vitest";
import { BUILT_IN_RISK_RULES } from "../src/config/policies.js";
import { changedLines, matchRiskRules, type ChangedFile } from "../src/policies/risk.js";

const file = (path: string, addedLines: string[] = ["x"], removed = 0): ChangedFile => ({ path, added: addedLines.length, removed, addedLines });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
const check = (files: ChangedFile[], labels: string[] = [], sizeCap = 400) =>
  matchRiskRules(BUILT_IN_RISK_RULES, { labels, files, sizeCap });

describe("matchRiskRules: the built-in Risk rules", () => {
  test.each([
    ["auth", "src/auth/session.ts"],
    ["auth", "auth/login.go"],
    ["payments", "app/billing/invoice.ts"],
    ["payments", "services/payments/charge.py"],
    ["migrations", "db/migrations/0042_add_users.sql"],
    ["migrations", "db/schema.sql"],
    ["migrations", "prisma/schema.prisma"],
    ["secrets", ".env"],
    ["secrets", "config/.env.production"],
    ["ci-config", ".github/workflows/ci.yml"],
    ["ci-config", ".github/actions/setup/action.yml"],
    ["auth", "src/oauth/callback.ts"],
    ["secrets", "deploy/server.pem"],
  ])("%s matches %s", (rule, path) => {
    expect(check([file(path)]).map((m) => m.rule)).toEqual([rule]);
  });

  test("secrets matches a private key in an added line, whatever the file", () => {
    const matches = check([file("src/fixtures/key.txt", ["-----BEGIN PRIVATE KEY-----", "MIIE..."])]);
    expect(matches).toEqual([{ rule: "secrets", why: 'an added line in src/fixtures/key.txt contains "PRIVATE KEY-----"' }]);
  });

  test.each(["-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----"])("secrets matches %s", (line) => {
    expect(check([file("src/fixtures/key.txt", [line])]).map((m) => m.rule)).toEqual(["secrets"]);
  });

  test("an ordinary change matches nothing", () => {
    expect(check([file("src/app.ts"), file("README.md"), file("src/authors.ts")])).toEqual([]);
  });

  test("a path match says which file and glob", () => {
    expect(check([file("src/auth/session.ts")])).toEqual([{ rule: "auth", why: "src/auth/session.ts matches **/auth/**" }]);
  });

  test("each rule is reported once, at its first match", () => {
    expect(check([file("src/auth/a.ts"), file("src/auth/b.ts")])).toHaveLength(1);
  });
});

describe("matchRiskRules: configured rules", () => {
  const rules = [{ name: "infra", labels: ["infra"], keywords: ["DROP TABLE"] }];

  test("a rule matches by label", () => {
    expect(matchRiskRules(rules, { labels: ["infra"], files: [], sizeCap: 400 })).toEqual([{ rule: "infra", why: "the issue has the infra label" }]);
  });

  test("a keyword only counts in added lines", () => {
    const removedOnly: ChangedFile = { path: "db/seed.sql", added: 1, removed: 1, addedLines: ["-- tidy"] };
    expect(matchRiskRules(rules, { labels: [], files: [removedOnly], sizeCap: 400 })).toEqual([]);
    expect(matchRiskRules(rules, { labels: [], files: [file("db/seed.sql", ["DROP TABLE users;"])], sizeCap: 400 })).toHaveLength(1);
  });
});

describe("matchRiskRules: the size cap", () => {
  test("more changed lines than the cap is a match", () => {
    expect(check([file("src/a.ts", lines(300), 101)])).toEqual([{ rule: "size-cap", why: "401 changed lines, over the 400-line size cap" }]);
  });

  test("exactly the cap is not", () => {
    expect(check([file("src/a.ts", lines(300), 100)])).toEqual([]);
  });

  test("a tightened cap applies", () => {
    expect(check([file("src/a.ts", lines(60))], [], 50).map((m) => m.rule)).toEqual(["size-cap"]);
  });

  test("lockfiles and generated files don't count", () => {
    const files = [
      file("package-lock.json", lines(5000)),
      file("web/pnpm-lock.yaml", lines(900)),
      file("yarn.lock", lines(900)),
      file("go.sum", lines(900)),
      file("Cargo.lock", lines(900)),
      file("dist/bundle.js", lines(900)),
      file("public/app.min.js", lines(900)),
      file("src/api/client.generated.ts", lines(900)),
      file("src/__generated__/types.ts", lines(900)),
      file("src/a.ts", lines(10)),
    ];
    expect(changedLines(files)).toBe(10);
    expect(check(files)).toEqual([]);
  });
});
