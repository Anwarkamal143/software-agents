import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ToolProfile } from "../config/types.js";
import { Git } from "./git.js";
import type { Incoming, WorkingCopy } from "./clones.js";

export type PrePushCheckName = "only-job-branch" | "tool-profile" | "outward-symlink" | "submodule" | "secret-scan";

export interface PrePushFailure {
  check: PrePushCheckName;
  message: string;
}

const short = (sha: string) => sha.slice(0, 12);

/**
 * What the Orchestrator verifies about an agent's commits, in quarantine, before it
 * pushes them itself (ADR 0007). Any failure means nothing is pushed.
 */
export class PrePushChecks {
  private readonly git: Git;

  constructor(
    home: string,
    private readonly options: { gitleaks: string },
  ) {
    this.git = new Git(join(home, "git-home"));
  }

  /** `before` is the Job branch as last pushed (the base, before the first push). */
  async run(wc: WorkingCopy, incoming: Incoming, { before, profile }: { before: string; profile: ToolProfile }): Promise<PrePushFailure[]> {
    const failures: PrePushFailure[] = [];
    const branchRef = `refs/heads/${wc.branch}`;
    for (const ref of Object.keys(incoming.refs).sort()) {
      if (ref !== branchRef) failures.push({ check: "only-job-branch", message: `${ref} isn't the Job branch ${wc.branch}.` });
    }
    const head = incoming.head;
    if (!head) return [...failures, { check: "only-job-branch", message: `The Job branch ${wc.branch} is gone.` }];

    const cwd = incoming.quarantine;
    if (!(await this.git.test(["merge-base", "--is-ancestor", before, head], { cwd }))) {
      failures.push({ check: "only-job-branch", message: `${wc.branch} no longer contains ${short(before)}, which was already pushed.` });
      return failures;
    }
    if (head === before) return failures;
    if (profile === "read-only") {
      failures.push({ check: "tool-profile", message: `A read-only Stage committed: ${wc.branch} moved from ${short(before)} to ${short(head)}.` });
    }

    const commits = (await this.git.run(["rev-list", "--reverse", `${before}..${head}`], { cwd })).split("\n").filter(Boolean);
    const seen = new Set<string>();
    const add = (f: PrePushFailure) => {
      if (!seen.has(f.message)) failures.push(f);
      seen.add(f.message);
    };
    // Links that already escaped before this push are the Target repo's own, not the agent's.
    const alreadyEscaping = new Set((await this.escapingLinks(cwd, before)).map((l) => l.path));
    for (const commit of commits) {
      const changes = parseRawDiff(await this.git.run(["diff-tree", "-r", "-z", "-m", "--no-renames", "--no-commit-id", commit], { cwd }));
      for (const change of changes) {
        if (change.path === ".gitmodules") add({ check: "submodule", message: ".gitmodules changed." });
        if (change.oldMode === "160000" || change.newMode === "160000") add({ check: "submodule", message: `${change.path} is a submodule.` });
      }
      // A new link can make an old one escape, so resolve every link in the tree whenever any changed.
      if (changes.some((c) => c.newMode === "120000" || c.oldMode === "120000")) {
        for (const link of await this.escapingLinks(cwd, commit)) {
          if (!alreadyEscaping.has(link.path)) add({ check: "outward-symlink", message: `${link.path} ${link.why} (${link.target}).` });
        }
      }
    }
    const symlinkFailures = failures.filter((f) => f.check === "outward-symlink").sort((a, b) => a.message.localeCompare(b.message));
    failures.splice(0, failures.length, ...failures.filter((f) => f.check !== "outward-symlink"), ...symlinkFailures);

    const added = await this.addedLines(cwd, before, head);
    const rules = await this.scan(added);
    if (rules.length) {
      const names = [...new Set(rules)].sort().join(", ");
      failures.push({ check: "secret-scan", message: `gitleaks found ${rules.length} secret${rules.length === 1 ? "" : "s"} (${names}).` });
    }
    return failures;
  }

  /**
   * Every line added by every commit, binary files included (`--text`), plus every commit
   * message, so a secret added then removed, hidden in a "binary" file or written in a
   * message is still caught.
   */
  private async addedLines(cwd: string, before: string, head: string): Promise<string> {
    const range = `${before}..${head}`;
    const log = await this.git.run(["log", "-p", "-m", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", range], { cwd });
    const messages = await this.git.run(["log", "--format=%B", range], { cwd });
    const added = log
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++ "))
      .map((l) => l.slice(1));
    return [...added, messages].join("\n");
  }

  /** Every symlink in `commit`'s tree that, followed through the tree's other links, leaves it or enters `.git`. */
  private async escapingLinks(cwd: string, commit: string): Promise<{ path: string; target: string; why: string }[]> {
    const tree = await this.git.run(["ls-tree", "-r", "-z", "--full-tree", commit], { cwd });
    const links = new Map<string, string>();
    for (const entry of tree.split("\0").filter(Boolean)) {
      const [meta, path] = entry.split("\t") as [string, string];
      const [mode, , sha] = meta.split(" ") as [string, string, string];
      if (mode === "120000") links.set(path, await this.git.run(["cat-file", "blob", sha], { cwd }));
    }
    const out = [];
    for (const [path, target] of links) {
      const why = followLink(path, links);
      if (why) out.push({ path, target, why });
    }
    return out;
  }

  /**
   * Runs the pinned gitleaks on `text` from an empty folder with a bare environment,
   * so nothing the agent wrote (a `.gitleaks.toml`, `.gitleaksignore` or
   * `gitleaks:allow` comment) can switch a rule off. Returns the rule id of each finding.
   */
  private async scan(text: string): Promise<string[]> {
    if (!text) return [];
    const dir = mkdtempSync(join(tmpdir(), "factory-gitleaks-"));
    try {
      const report = join(dir, "report.json");
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          this.options.gitleaks,
          [
            "stdin",
            "--no-banner",
            "--no-color",
            "--ignore-gitleaks-allow",
            "--redact",
            "--log-level=error",
            "--exit-code=0",
            "--report-format=json",
            `--report-path=${report}`,
            `--gitleaks-ignore-path=${dir}`,
          ],
          { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, maxBuffer: 64 * 1024 * 1024 },
          (err, _stdout, stderr) => (err ? reject(new Error(`gitleaks failed: ${stderr || err.message}`)) : resolve()),
        );
        child.stdin!.end(text);
      });
      const findings = JSON.parse(readFileSync(report, "utf8")) as { RuleID: string }[];
      return findings.map((f) => f.RuleID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface Change {
  oldMode: string;
  newMode: string;
  newSha: string;
  status: string;
  path: string;
}

/** Parses `git diff-tree -r -z --no-renames` output: `:old new osha nsha S\0path\0` … */
function parseRawDiff(raw: string): Change[] {
  const tokens = raw.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    if (!meta.startsWith(":")) {
      i -= 1; // a commit id line from -m between parents
      continue;
    }
    const [oldMode, newMode, , newSha, status] = meta.slice(1).split(" ") as [string, string, string, string, string];
    changes.push({ oldMode, newMode, newSha, status, path: tokens[i + 1]! });
  }
  return changes;
}

/**
 * Follows the link at `path` through the tree's other links, the way a filesystem
 * would. Returns why it is refused (it leaves the Working copy, or reaches a `.git`
 * in any letter case), or null if it stays inside.
 */
function followLink(path: string, links: Map<string, string>): string | null {
  const OUTSIDE = "points outside the Working copy";
  const INTO_GIT = "points into .git";
  let hops = 0;
  const walk = (from: string[], target: string): string[] | string => {
    if (posix.isAbsolute(target)) return OUTSIDE;
    const parts = [...from];
    for (const component of target.split("/")) {
      if (component === "" || component === ".") continue;
      if (component === "..") {
        if (!parts.length) return OUTSIDE;
        parts.pop();
        continue;
      }
      if (component.toLowerCase() === ".git") return INTO_GIT;
      parts.push(component);
      const next = links.get(parts.join("/"));
      if (next !== undefined) {
        if (++hops > 40) return OUTSIDE; // a loop: refuse rather than guess
        const resolved = walk(parts.slice(0, -1), next);
        if (typeof resolved === "string") return resolved;
        parts.splice(0, parts.length, ...resolved);
      }
    }
    return parts;
  };
  const result = walk(posix.dirname(path) === "." ? [] : posix.dirname(path).split("/"), links.get(path)!);
  return typeof result === "string" ? result : null;
}
