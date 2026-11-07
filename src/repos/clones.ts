import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { GitHubAuth } from "../github/auth.js";
import type { ChangedFile } from "../policies/risk.js";
import type { SelfEditInput } from "../policies/merge-gate.js";
import { Git, HARDENED_UPLOAD_PACK, remoteAuthEnv, type GitOptions } from "./git.js";

/** An Attempt's own clone of the Target repo: the only place its agents may write (ADR 0008). */
export interface WorkingCopy {
  /** The clone itself: where the Attempt's agents work. */
  path: string;
  job_id: string;
  attempt: number;
  branch: string;
  /** The Trusted clone this Working copy was made from. */
  trustedClone: string;
  /** The default-branch commit the Attempt started from. */
  base: string;
  /** The Attempt's own HOME, config, caches and temp folder; Stage runs get these instead of yours. */
  env: { HOME: string; XDG_CONFIG_HOME: string; XDG_CACHE_HOME: string; npm_config_cache: string; TMPDIR: string };
  /** The Attempt's folder, holding the clone, its HOME, caches and the quarantine. */
  attemptDir: string;
}

/** What an agent left in its Working copy, fetched into quarantine, not yet trusted. */
export interface Incoming {
  /** A bare repo that borrows the Trusted clone's objects; incoming objects stay here until they pass. */
  quarantine: string;
  /** Every branch and tag the Working copy has, by full ref name. */
  refs: Record<string, string>;
  /** The Job branch's head, or null if the agent deleted it. */
  head: string | null;
}

export interface StartAttempt {
  repo: string;
  job_id: string;
  attempt: number;
  branch: string;
}

/** What the Merge gate rebase did to the Job branch. */
export type Rebase =
  /** The branch already contains the default branch's head, `base`. */
  | { kind: "up-to-date"; base: string }
  /** Rebased onto `base` and pushed as `head`. */
  | { kind: "rebased"; base: string; head: string }
  /** Replaying the branch onto `base` conflicts in `files`; nothing was pushed. */
  | { kind: "conflict"; base: string; files: string[] };

/** A change as the Merge gate judges it: against where it branched from the default branch. */
export interface Change {
  files: ChangedFile[];
  packageJson: SelfEditInput["packageJson"];
}

export interface ClonesOptions {
  /** Where the Trusted clone fetches from and pushes to. */
  remoteUrl: (repo: string) => string;
  /** The Factory's GitHub token for `repo`, asked for on every call that reaches the remote and never written down (ADR 0007). */
  token?: (repo: string) => Promise<string>;
}

/** Clones of GitHub repos, fetched and pushed with the Factory's own GitHub token for each repo. */
export function gitHubClones(home: string, auth: GitHubAuth): Clones {
  return new Clones(home, { remoteUrl: (repo) => `https://github.com/${repo}.git`, token: (repo) => auth.token(repo) });
}

/**
 * Trusted clones and Working copies under the Factory home. The Orchestrator never
 * runs git inside a Working copy: it fetches out of one into quarantine, checks
 * there, and moves only what passes into the Trusted clone (ADR 0008).
 */
export class Clones {
  private readonly git: Git;
  /** One git writer at a time per Trusted clone, so parallel Stage runs don't fight over ref locks. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly home: string,
    private readonly options: ClonesOptions,
  ) {
    this.git = new Git(join(home, "git-home"));
  }

  /** Options for a git call in `cwd` that reaches `repo`'s remote: carries its token, if there is one. */
  private async remote(repo: string, cwd: string): Promise<GitOptions> {
    if (!this.options.token) return { cwd };
    return { cwd, env: remoteAuthEnv(this.options.remoteUrl(repo), await this.options.token(repo)) };
  }

  /** The repo a Trusted clone, `<home>/repos/<owner>/<name>.git`, is of. */
  private repoOf(trustedClone: string): string {
    return relative(join(this.home, "repos"), trustedClone).replace(/\.git$/, "");
  }

  private exclusive<T>(trustedClone: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(trustedClone) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(trustedClone, next.catch(() => undefined));
    return next;
  }

  /** The Trusted clone of `repo`, made on first use. Agents never touch it. */
  async trustedClone(repo: string): Promise<{ dir: string; defaultBranch: string }> {
    const dir = join(this.home, "repos", `${repo}.git`);
    return this.exclusive(dir, () => this.ensureTrustedClone(repo, dir));
  }

  private async ensureTrustedClone(repo: string, dir: string): Promise<{ dir: string; defaultBranch: string }> {
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(join(dir, ".."), { recursive: true });
      await this.git.run(["clone", "--quiet", "--bare", "--template=", this.options.remoteUrl(repo), dir], await this.remote(repo, this.home));
      await this.git.run(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: dir });
    }
    const defaultBranch = (await this.git.run(["symbolic-ref", "--short", "HEAD"], { cwd: dir })).trim();
    return { dir, defaultBranch };
  }

  /** A fresh Working copy for a new Attempt, on its own branch from the current default branch. */
  async startAttempt({ repo, job_id, attempt, branch }: StartAttempt): Promise<WorkingCopy> {
    const trusted = await this.trustedClone(repo);
    const base = await this.exclusive(trusted.dir, async () => {
      await this.git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], await this.remote(repo, trusted.dir));
      const sha = (await this.git.run(["rev-parse", `refs/remotes/origin/${trusted.defaultBranch}^{commit}`], { cwd: trusted.dir })).trim();
      await this.git.run(["update-ref", `refs/heads/${branch}`, sha], { cwd: trusted.dir });
      return sha;
    });

    const wc = this.workingCopy({ repo, job_id, attempt, branch, base });
    rmSync(wc.attemptDir, { recursive: true, force: true });
    for (const d of Object.values(wc.env)) mkdirSync(d, { recursive: true });
    await this.cloneWorkingCopy(wc);
    return wc;
  }

  /** The Working copy itself: the Job branch as the Trusted clone has it, borrowing its objects. */
  private async cloneWorkingCopy(wc: WorkingCopy): Promise<void> {
    await this.git.run(
      ["clone", "--quiet", "--reference", wc.trustedClone, "--single-branch", "--branch", wc.branch, "--no-tags", "--template=", wc.trustedClone, wc.path],
      { cwd: wc.attemptDir },
    );
  }

  /** Where an Attempt's Working copy lives, as recorded on `attempt-started`. Creates nothing. */
  workingCopy({ repo, job_id, attempt, branch, base }: StartAttempt & { base: string }): WorkingCopy {
    const dir = join(this.home, "work", job_id, `a${attempt}`);
    return {
      path: join(dir, "repo"),
      job_id,
      attempt,
      branch,
      trustedClone: join(this.home, "repos", `${repo}.git`),
      base,
      attemptDir: dir,
      env: {
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: join(dir, "home", ".config"),
        XDG_CACHE_HOME: join(dir, "cache"),
        npm_config_cache: join(dir, "cache", "npm"),
        TMPDIR: join(dir, "tmp"),
      },
    };
  }

  /** The Target repo's CLAUDE.md or AGENTS.md at the Attempt's base, read from the Trusted clone, not the Working copy. */
  async conventions(wc: WorkingCopy): Promise<string> {
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      if (await this.git.test(["cat-file", "-e", `${wc.base}:${file}`], { cwd: wc.trustedClone })) {
        return this.git.run(["show", `${wc.base}:${file}`], { cwd: wc.trustedClone });
      }
    }
    return "";
  }

  /** Files changed between two commits, measured by the Orchestrator itself. */
  async filesChanged(incoming: Incoming, before: string, head: string): Promise<string[]> {
    const out = await this.git.run(["diff", "--name-only", "-z", "--no-renames", before, head], { cwd: incoming.quarantine });
    return out.split("\0").filter(Boolean);
  }

  /**
   * What `head` changes against where it meets the default branch, measured in the Trusted clone:
   * each file's added and removed lines, and every changed `package.json` before and after.
   */
  async changes(wc: WorkingCopy, head: string): Promise<Change> {
    const cwd = wc.trustedClone;
    const base = (await this.git.run(["merge-base", `refs/remotes/origin/${await this.defaultBranchOf(cwd)}`, head], { cwd })).trim();
    const numstat = await this.git.run(["diff", "--numstat", "-z", "--no-renames", base, head], { cwd });
    const files = new Map<string, ChangedFile>();
    for (const entry of numstat.split("\0").filter(Boolean)) {
      const [added, removed, path] = entry.split("\t") as [string, string, string];
      files.set(path, { path, added: Number(added) || 0, removed: Number(removed) || 0, addedLines: [] });
    }
    let current: ChangedFile | undefined;
    for (const line of (await this.git.run(["diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", base, head], { cwd })).split("\n")) {
      if (line.startsWith("+++ ")) current = files.get(line.slice("+++ b/".length));
      else if (line.startsWith("+") && current) current.addedLines.push(line.slice(1));
    }
    const show = (commit: string, path: string) => this.git.run(["show", `${commit}:${path}`], { cwd }).catch(() => null);
    const packageJson: Change["packageJson"] = [];
    for (const path of files.keys()) {
      if (path === "package.json" || path.endsWith("/package.json")) packageJson.push({ path, before: await show(base, path), after: await show(head, path) });
    }
    return { files: [...files.values()], packageJson };
  }

  /**
   * The Merge gate's re-verify (ADR 0008): fetches the default branch and, if the Job branch at
   * `head` doesn't contain it, rebases the branch onto it in a worktree of the Trusted clone and
   * pushes the result. A conflict pushes nothing and names the conflicting files.
   */
  async rebaseOntoDefault(wc: WorkingCopy, head: string): Promise<Rebase> {
    const cwd = wc.trustedClone;
    const origin = () => this.remote(this.repoOf(cwd), cwd);
    return this.exclusive(cwd, async () => {
      await this.git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], await origin());
      const base = (await this.git.run(["rev-parse", `refs/remotes/origin/${await this.defaultBranchOf(cwd)}^{commit}`], { cwd })).trim();
      if (await this.git.test(["merge-base", "--is-ancestor", base, head], { cwd })) return { kind: "up-to-date", base };
      const dir = join(wc.attemptDir, "rebase");
      rmSync(dir, { recursive: true, force: true });
      await this.git.test(["worktree", "prune"], { cwd });
      await this.git.run(["worktree", "add", "--quiet", "--detach", dir, head], { cwd });
      try {
        if (!(await this.git.test(["rebase", "--quiet", base], { cwd: dir }))) {
          const files = (await this.git.run(["diff", "--name-only", "-z", "--diff-filter=U"], { cwd: dir })).split("\0").filter(Boolean);
          await this.git.test(["rebase", "--abort"], { cwd: dir });
          return { kind: "conflict", base, files };
        }
        const rebased = (await this.git.run(["rev-parse", "HEAD"], { cwd: dir })).trim();
        const ref = `refs/heads/${wc.branch}`;
        await this.git.run(["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${head}`, "origin", `${rebased}:${ref}`], await origin());
        await this.git.run(["update-ref", ref, rebased], { cwd });
        // A later Bounce builds on the rebased branch, so the Working copy is made again from it.
        rmSync(wc.path, { recursive: true, force: true });
        await this.cloneWorkingCopy(wc);
        return { kind: "rebased", base, head: rebased };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await this.git.test(["worktree", "prune"], { cwd });
      }
    });
  }

  /**
   * Reverts `merged` on top of the current default branch, in a worktree of the Trusted clone, and
   * pushes it as `branch`. A branch this already pushed is reused, so a restart never makes a
   * second revert. Null if the revert doesn't apply cleanly.
   */
  async pushRevert(repo: string, merged: string, branch: string): Promise<string | null> {
    const { dir: cwd, defaultBranch } = await this.trustedClone(repo);
    const ref = `refs/heads/${branch}`;
    return this.exclusive(cwd, async () => {
      const remote = (await this.git.run(["ls-remote", "--heads", "origin", ref], await this.remote(repo, cwd))).split("\t")[0]?.trim();
      if (remote) return remote;
      await this.git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], await this.remote(repo, cwd));
      const dir = join(this.home, "reverts", branch.replaceAll("/", "_"));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, ".."), { recursive: true });
      await this.git.test(["worktree", "prune"], { cwd });
      await this.git.run(["worktree", "add", "--quiet", "--detach", dir, `refs/remotes/origin/${defaultBranch}`], { cwd });
      try {
        // A merge commit is reverted against its first parent; a squash or rebase has only the one.
        const parents = (await this.git.run(["rev-list", "--parents", "-n", "1", merged], { cwd })).trim().split(" ").length - 1;
        if (!(await this.git.test(["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), merged], { cwd: dir }))) {
          await this.git.test(["revert", "--abort"], { cwd: dir });
          return null;
        }
        const head = (await this.git.run(["rev-parse", "HEAD"], { cwd: dir })).trim();
        await this.git.run(["push", "--quiet", "--no-verify", "origin", `${head}:${ref}`], await this.remote(repo, cwd));
        await this.git.run(["update-ref", ref, head], { cwd });
        return head;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await this.git.test(["worktree", "prune"], { cwd });
      }
    });
  }

  private async defaultBranchOf(trustedClone: string): Promise<string> {
    return (await this.git.run(["symbolic-ref", "--short", "HEAD"], { cwd: trustedClone })).trim();
  }

  /** Fetches every branch and tag out of the Working copy into a fresh quarantine. */
  async receive(wc: WorkingCopy): Promise<Incoming> {
    const gitDir = join(wc.path, ".git");
    assertOwnGitDir(gitDir, join(wc.trustedClone, "objects"));

    const quarantine = join(wc.attemptDir, "incoming.git");
    rmSync(quarantine, { recursive: true, force: true });
    await this.git.run(["init", "--quiet", "--bare", "--template=", quarantine], { cwd: wc.attemptDir });
    writeFileSync(join(quarantine, "objects", "info", "alternates"), `${join(wc.trustedClone, "objects")}\n`);
    await this.git.run(
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", `--upload-pack=${HARDENED_UPLOAD_PACK}`, gitDir, "+refs/heads/*:refs/incoming/heads/*", "+refs/tags/*:refs/incoming/tags/*"],
      { cwd: quarantine },
    );
    const listing = await this.git.run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/incoming/"], { cwd: quarantine });
    const refs: Record<string, string> = {};
    for (const line of listing.split("\n").filter(Boolean)) {
      const [sha, name] = line.split(" ") as [string, string];
      refs[name.replace("refs/incoming/", "refs/")] = sha;
    }
    return { quarantine, refs, head: refs[`refs/heads/${wc.branch}`] ?? null };
  }

  /**
   * Moves the checked Job branch from quarantine into the Trusted clone and pushes it.
   * `remoteHead` is what the remote branch should be now (null if never pushed), so a
   * branch someone else moved is refused rather than overwritten.
   */
  async push(wc: WorkingCopy, incoming: Incoming, { remoteHead }: { remoteHead: string | null }): Promise<void> {
    if (!incoming.head) throw new Error(`The Working copy has no ${wc.branch} branch to push.`);
    const ref = `refs/heads/${wc.branch}`;
    await this.exclusive(wc.trustedClone, async () => {
      await this.git.run(
        ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", `--upload-pack=${HARDENED_UPLOAD_PACK}`, incoming.quarantine, `+refs/incoming/heads/${wc.branch}:${ref}`],
        { cwd: wc.trustedClone },
      );
      await this.git.run(["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${remoteHead ?? ""}`, "origin", `${ref}:${ref}`], await this.remote(this.repoOf(wc.trustedClone), wc.trustedClone));
    });
  }

  /** A clean checkout of exactly `commit`, for a Check Stage run. Delete it with `removeCheckout`. */
  async checkStageCopy(wc: WorkingCopy, commit: string, name: string): Promise<string> {
    const dir = join(wc.attemptDir, "checks", name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".."), { recursive: true });
    await this.git.run(["clone", "--quiet", "--no-checkout", "--reference", wc.trustedClone, "--no-tags", "--template=", wc.trustedClone, dir], { cwd: wc.attemptDir });
    await this.git.run(["checkout", "--quiet", "--detach", commit], { cwd: dir });
    return dir;
  }

  removeCheckStageCopy(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Deletes Job branches on the remote, from the Trusted clone. Returns those gone now:
   * deleted, or never there. Throws if the remote can't be reached, so a sweep tries again.
   */
  async deleteBranches(repo: string, branches: string[]): Promise<string[]> {
    const trusted = await this.trustedClone(repo);
    return this.exclusive(trusted.dir, async () => {
      const listing = await this.git.run(["ls-remote", "--heads", "origin", ...branches.map((b) => `refs/heads/${b}`)], await this.remote(repo, trusted.dir));
      const present = new Set(listing.split("\n").filter(Boolean).map((l) => l.split("\t")[1]!.replace("refs/heads/", "")));
      const existing = branches.filter((b) => present.has(b));
      if (existing.length) await this.git.run(["push", "--quiet", "--no-verify", "origin", ...existing.map((b) => `:refs/heads/${b}`)], await this.remote(repo, trusted.dir));
      for (const b of branches) await this.git.test(["update-ref", "-d", `refs/heads/${b}`], { cwd: trusted.dir });
      return branches;
    });
  }

  /** The default branch's head as the remote has it now, fetched into the Trusted clone. */
  async defaultHead(repo: string): Promise<string> {
    const trusted = await this.trustedClone(repo);
    return this.exclusive(trusted.dir, async () => {
      await this.git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], await this.remote(repo, trusted.dir));
      return (await this.git.run(["rev-parse", `refs/remotes/origin/${trusted.defaultBranch}^{commit}`], { cwd: trusted.dir })).trim();
    });
  }

  /** A file at `commit`, read from the Trusted clone; null if there is none. */
  async readFile(repo: string, commit: string, path: string): Promise<string | null> {
    const { dir } = await this.trustedClone(repo);
    if (!(await this.git.test(["cat-file", "-e", `${commit}:${path}`], { cwd: dir }))) return null;
    return this.git.run(["show", `${commit}:${path}`], { cwd: dir });
  }

  /**
   * A clean checkout of `commit` for the Baseline check, with its own HOME, caches and temp folder
   * like an Attempt's. Delete it with `removeBaselineCopy`.
   */
  async baselineCopy(repo: string, commit: string): Promise<{ dir: string; root: string; env: WorkingCopy["env"] }> {
    const { dir: trusted } = await this.trustedClone(repo);
    const root = join(this.home, "work", "baseline", repo.replace("/", "__"));
    rmSync(root, { recursive: true, force: true });
    const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", ".config"), XDG_CACHE_HOME: join(root, "cache"), npm_config_cache: join(root, "cache", "npm"), TMPDIR: join(root, "tmp") };
    for (const d of Object.values(env)) mkdirSync(d, { recursive: true });
    const dir = join(root, "repo");
    await this.git.run(["clone", "--quiet", "--no-checkout", "--reference", trusted, "--no-tags", "--template=", trusted, dir], { cwd: root });
    await this.git.run(["checkout", "--quiet", "--detach", commit], { cwd: dir });
    return { dir, root, env };
  }

  removeBaselineCopy(root: string): void {
    rmSync(root, { recursive: true, force: true });
  }

  /** Deletes every Working copy of a Job: on merged or cancelled (ADR 0008). */
  async removeJob(job_id: string): Promise<void> {
    rmSync(join(this.home, "work", job_id), { recursive: true, force: true });
  }
}

/**
 * The Orchestrator's fetch runs outside the Sandbox, so before it reads a Working
 * copy's `.git` that `.git` must hold only its own repo: no gitfile, no `commondir`,
 * no symlinks anywhere inside, and no alternates beyond the Trusted clone it was
 * cloned with. Otherwise the fetch could be pointed at another Job's or another
 * Target repo's objects and push them here.
 */
function assertOwnGitDir(gitDir: string, trustedObjects: string): void {
  const refuse = (why: string): never => {
    throw new Error(`${gitDir} ${why}; refusing to fetch from it.`);
  };
  if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) refuse("is not a directory");
  for (const name of ["commondir", "gitdir", join("objects", "info", "http-alternates")]) {
    if (lstatSync(join(gitDir, name), { throwIfNoEntry: false })) refuse(`has ${name}`);
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) refuse(`contains a symlink (${join(dir, entry.name)})`);
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(gitDir);
  const alternates = join(gitDir, "objects", "info", "alternates");
  if (existsSync(alternates)) {
    const lines = readFileSync(alternates, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
    if (lines.some((l) => real(l) !== real(trustedObjects))) refuse("borrows objects from somewhere other than its Trusted clone");
  }
}
