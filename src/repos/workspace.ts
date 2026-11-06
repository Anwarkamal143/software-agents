import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git, HARDENED_UPLOAD_PACK } from "./git.js";

/** An Attempt's own clone of the Target repo: the only place its agents may write (ADR 0008). */
export interface WorkingCopy {
  repo: string;
  job_id: string;
  attempt: number;
  branch: string;
  /** The Trusted clone this Working copy was made from. */
  trustedClone: string;
  /** The default-branch commit the Attempt started from. */
  base: string;
  /** The Attempt's own HOME, config, caches and temp folder; Stage runs get these instead of yours. */
  env: { HOME: string; XDG_CONFIG_HOME: string; XDG_CACHE_HOME: string; npm_config_cache: string; TMPDIR: string };
  /** The Attempt's folder, holding `repo`, its HOME, caches and the quarantine. */
  dir: string;
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

export interface RepoWorkspaceOptions {
  /** Where the Trusted clone fetches from and pushes to. */
  remoteUrl: (repo: string) => string;
}

/**
 * Trusted clones and Working copies under the Factory home. The Orchestrator never
 * runs git inside a Working copy: it fetches out of one into quarantine, checks
 * there, and moves only what passes into the Trusted clone (ADR 0008).
 */
export class RepoWorkspace {
  private readonly git: Git;

  constructor(
    private readonly home: string,
    private readonly options: RepoWorkspaceOptions,
  ) {
    this.git = new Git(join(home, "git-home"));
  }

  /** The Trusted clone of `repo`, made on first use. Agents never touch it. */
  async trustedClone(repo: string): Promise<{ dir: string; defaultBranch: string }> {
    const dir = join(this.home, "repos", `${repo}.git`);
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(join(dir, ".."), { recursive: true });
      await this.git.run(["clone", "--quiet", "--bare", "--template=", this.options.remoteUrl(repo), dir], { cwd: this.home });
      await this.git.run(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: dir });
    }
    const defaultBranch = (await this.git.run(["symbolic-ref", "--short", "HEAD"], { cwd: dir })).trim();
    return { dir, defaultBranch };
  }

  /** A fresh Working copy for a new Attempt, on its own branch from the current default branch. */
  async startAttempt({ repo, job_id, attempt, branch }: StartAttempt): Promise<WorkingCopy> {
    const trusted = await this.trustedClone(repo);
    await this.git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], { cwd: trusted.dir });
    const base = (await this.git.run(["rev-parse", `refs/remotes/origin/${trusted.defaultBranch}^{commit}`], { cwd: trusted.dir })).trim();
    await this.git.run(["update-ref", `refs/heads/${branch}`, base], { cwd: trusted.dir });

    const wc = this.workingCopy({ repo, job_id, attempt, branch, base });
    rmSync(wc.dir, { recursive: true, force: true });
    for (const d of Object.values(wc.env)) mkdirSync(d, { recursive: true });
    await this.git.run(
      ["clone", "--quiet", "--reference", trusted.dir, "--single-branch", "--branch", branch, "--no-tags", "--template=", trusted.dir, wc.repo],
      { cwd: wc.dir },
    );
    return wc;
  }

  /** Where an Attempt's Working copy lives, as recorded on `attempt-started`. Creates nothing. */
  workingCopy({ repo, job_id, attempt, branch, base }: StartAttempt & { base: string }): WorkingCopy {
    const dir = join(this.home, "work", job_id, `a${attempt}`);
    return {
      repo: join(dir, "repo"),
      job_id,
      attempt,
      branch,
      trustedClone: join(this.home, "repos", `${repo}.git`),
      base,
      dir,
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

  /** Fetches every branch and tag out of the Working copy into a fresh quarantine. */
  async receive(wc: WorkingCopy): Promise<Incoming> {
    const gitDir = join(wc.repo, ".git");
    // A gitfile or symlink here could point the fetch at another Job's repo.
    if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${gitDir} is not a directory; refusing to fetch from it.`);

    const quarantine = join(wc.dir, "incoming.git");
    rmSync(quarantine, { recursive: true, force: true });
    await this.git.run(["init", "--quiet", "--bare", "--template=", quarantine], { cwd: wc.dir });
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
    await this.git.run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", incoming.quarantine, `+refs/incoming/heads/${wc.branch}:${ref}`], {
      cwd: wc.trustedClone,
    });
    await this.git.run(["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${remoteHead ?? ""}`, "origin", `${ref}:${ref}`], { cwd: wc.trustedClone });
  }

  /** A clean checkout of exactly `commit`, for a Check Stage run. Delete it with `removeCheckout`. */
  async checkout(wc: WorkingCopy, commit: string, name: string): Promise<string> {
    const dir = join(wc.dir, "checks", name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".."), { recursive: true });
    await this.git.run(["clone", "--quiet", "--no-checkout", "--reference", wc.trustedClone, "--no-tags", "--template=", wc.trustedClone, dir], { cwd: wc.dir });
    await this.git.run(["checkout", "--quiet", "--detach", commit], { cwd: dir });
    return dir;
  }

  removeCheckout(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }

  /** Deletes every Working copy of a Job: on merged or cancelled (ADR 0008). */
  async removeJob(job_id: string): Promise<void> {
    rmSync(join(this.home, "work", job_id), { recursive: true, force: true });
  }
}
