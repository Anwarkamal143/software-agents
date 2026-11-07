import picomatch from "picomatch";
import type { RiskRule } from "../config/types.js";

/** One file of an Attempt's change against its base, as the Orchestrator measured it. */
export interface ChangedFile {
  path: string;
  /** What the change does to the file. A type change (file to symlink) counts as modified. */
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  /** The text of each added line, for keyword matching. */
  addedLines: string[];
}

export interface RiskMatch {
  /** The Risk rule's name, or `size-cap`. */
  rule: string;
  why: string;
}

export interface RiskInput {
  labels: string[];
  files: ChangedFile[];
  /** Changed lines allowed before a human must look, from the resolved Policies. */
  sizeCap: number;
}

/** Lockfiles and generated files: they don't count towards the size cap. */
const NOT_COUNTED = picomatch(
  [
    "**/package-lock.json",
    "**/npm-shrinkwrap.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/bun.lockb",
    "**/*.lock",
    "**/go.sum",
    "**/dist/**",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.generated.*",
    "**/__generated__/**",
  ],
  { dot: true },
);

/** Changed lines that count towards the size cap: added plus removed, without lockfiles and generated files. */
export function changedLines(files: ChangedFile[]): number {
  return files.filter((f) => !NOT_COUNTED(f.path)).reduce((n, f) => n + f.added + f.removed, 0);
}

/**
 * Every Risk rule the change matches, by label, path glob or keyword in an added
 * line, plus the size cap. Any match sends the Job to a human at any Autonomy level.
 */
export function matchRiskRules(rules: RiskRule[], { labels, files, sizeCap }: RiskInput): RiskMatch[] {
  const matches: RiskMatch[] = [];
  for (const rule of rules) {
    const why = riskRuleMatch(rule, labels, files);
    if (why) matches.push({ rule: rule.name, why });
  }
  const size = changedLines(files);
  if (size > sizeCap) matches.push({ rule: "size-cap", why: `${size} changed lines, over the ${sizeCap}-line size cap` });
  return matches;
}

/** Why `rule` matches, at its first match, or null. */
function riskRuleMatch(rule: RiskRule, labels: string[], files: ChangedFile[]): string | null {
  const label = rule.labels?.find((l) => labels.includes(l));
  if (label) return `the issue has the ${label} label`;
  for (const glob of rule.paths ?? []) {
    const matches = picomatch(glob, { dot: true });
    const hit = files.find((f) => matches(f.path));
    if (hit) return `${hit.path} matches ${glob}`;
  }
  for (const keyword of rule.keywords ?? []) {
    const hit = files.find((f) => f.addedLines.some((l) => l.includes(keyword)));
    if (hit) return `an added line in ${hit.path} contains "${keyword}"`;
  }
  return null;
}
