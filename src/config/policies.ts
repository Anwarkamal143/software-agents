import type { Autonomy, Policies, RiskRule } from "./types.js";

/** Policy values a Job gets when no layer sets them (Policies, #8). */
export const BUILT_IN_POLICIES: Policies = {
  autonomy: "trial",
  bounce_cap: 3,
  size_cap: 400,
  post_merge_watch_minutes: 60,
  budgets: {
    stage_run: { usd: 5, turns: 100, minutes: 30 },
    job: { usd: 20 },
    daily: { usd: 50 },
  },
};

/** Built-in Risk rules: auth, payments, migrations and schema, secrets and env files, CI config. */
export const BUILT_IN_RISK_RULES: RiskRule[] = [
  { name: "auth", paths: ["**/auth/**"] },
  { name: "payments", paths: ["**/billing/**", "**/payments/**"] },
  { name: "migrations", paths: ["**/migrations/**", "**/schema.sql", "**/*.prisma"] },
  { name: "secrets", paths: ["**/.env*"], keywords: ["BEGIN PRIVATE KEY"] },
  { name: "ci-config", paths: [".github/workflows/**"] },
];

const AUTONOMY: Autonomy[] = ["off", "trial", "auto"]; // left is stricter
const lowerIsStricter = (cur: unknown, next: unknown) => (next as number) <= (cur as number);
const higherIsStricter = (cur: unknown, next: unknown) => (next as number) >= (cur as number);

/** For each Policy key: is `next` at least as strict as `cur`? */
export const AT_LEAST_AS_STRICT: Record<string, (cur: unknown, next: unknown) => boolean> = {
  autonomy: (cur, next) => AUTONOMY.indexOf(next as Autonomy) <= AUTONOMY.indexOf(cur as Autonomy),
  bounce_cap: lowerIsStricter,
  size_cap: lowerIsStricter,
  "budgets.stage_run.usd": lowerIsStricter,
  "budgets.stage_run.turns": lowerIsStricter,
  "budgets.stage_run.minutes": lowerIsStricter,
  "budgets.job.usd": lowerIsStricter,
  "budgets.daily.usd": lowerIsStricter,
  post_merge_watch_minutes: higherIsStricter,
};

/** Policy keys that are Factory-wide values: only the Factory layer may set them. */
export const FACTORY_WIDE_POLICY_KEYS: ReadonlySet<string> = new Set(["budgets.daily.usd"]);

const LIST_KEYS = new Set(["risk_rules", "risk_rules_off"]);

/** `{ budgets: { job: { usd: 5 } } }` → `{ "budgets.job.usd": 5 }`. Risk-rule lists are left out. */
export function flatten(obj: object | undefined, prefix = "", out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (!prefix && LIST_KEYS.has(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** The inverse of `flatten`. */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}
