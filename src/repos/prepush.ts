import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ToolProfile } from "../config/types.js";
import { Git } from "./git.js";
import type { Incoming, WorkingCopy } from "./workspace.js";

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
    for (const commit of commits) {
      for (const change of parseRawDiff(await this.git.run(["diff-tree", "-r", "-z", "-m", "--no-renames", "--no-commit-id", commit], { cwd }))) {
        if (change.path === ".gitmodules") add({ check: "submodule", message: ".gitmodules changed." });
        if (change.oldMode === "160000" || change.newMode === "160000") add({ check: "submodule", message: `${change.path} is a submodule.` });
        if (change.newMode === "120000" && change.status !== "D") {
          const target = await this.git.run(["cat-file", "blob", change.newSha], { cwd });
          const why = outwardSymlink(change.path, target);
          if (why) add({ check: "outward-symlink", message: `${change.path} ${why} (${target}).` });
        }
      }
    }

    const added = await this.addedLines(cwd, before, head);
    const rules = await this.scan(added);
    if (rules.length) {
      const names = [...new Set(rules)].sort().join(", ");
      failures.push({ check: "secret-scan", message: `gitleaks found ${rules.length} secret${rules.length === 1 ? "" : "s"} (${names}).` });
    }
    return failures;
  }

  /** Every line added by every commit, so a secret added then removed is still caught. */
  private async addedLines(cwd: string, before: string, head: string): Promise<string> {
    const log = await this.git.run(["log", "-p", "-m", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", `${before}..${head}`], { cwd });
    return log
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++ "))
      .map((l) => l.slice(1))
      .join("\n");
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

/** Why a symlink at `path` pointing at `target` is refused, or null if it stays inside the worktree. */
function outwardSymlink(path: string, target: string): string | null {
  if (posix.isAbsolute(target)) return "points outside the worktree";
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../")) return "points outside the worktree";
  if (resolved === ".git" || resolved.startsWith(".git/")) return "points into .git";
  return null;
}
