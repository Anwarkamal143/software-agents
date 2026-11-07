import { resolve, type ResolvedStage } from "../config/resolve.js";
import type { FactoryConfig } from "../config/types.js";
import type { Clones } from "../repos/clones.js";
import type { CheckRunner } from "../stages/check-runner.js";

/** One Check Stage as a Job would run it: its commands, the hosts it may reach and the check secrets it gets. */
export type BaselineStage = Required<Pick<ResolvedStage, "id" | "commands" | "network" | "secrets">>;

export interface BaselineRequest {
  repo: string;
  /** The Check Stages, in Pipeline order. */
  checks: BaselineStage[];
  /** Check secret values, by name; each Check Stage gets only those it names. */
  secrets?: Record<string, string>;
}

export type BaselineResult =
  | { passed: true; head: string }
  | { passed: false; head: string; check: string; command: string; exit_code: number | null; output: string };

/**
 * The Baseline check (ADR 0011): every Check Stage's commands on the default branch's head, in a
 * clean checkout under the Sandbox, exactly as a Job's Check Stage would run them. A red baseline
 * would fail every Job. Throws `SandboxUnavailable` rather than run unconfined.
 */
export async function baselineCheck(clones: Clones, checks: CheckRunner, req: BaselineRequest): Promise<BaselineResult> {
  const head = await clones.defaultHead(req.repo);
  for (const check of req.checks) {
    const copy = await clones.baselineCopy(req.repo, head);
    const secrets = Object.fromEntries(Object.entries(req.secrets ?? {}).filter(([name]) => check.secrets.includes(name)));
    try {
      const run = await checks.run({
        commands: check.commands,
        cwd: copy.dir,
        env: { ...secrets, ...copy.env },
        writable: [copy.env.HOME, copy.env.XDG_CACHE_HOME, copy.env.TMPDIR],
        network: check.network,
      });
      if (!run.passed) return { passed: false, head, check: check.id, command: run.failed!.command, exit_code: run.failed!.exit_code, output: run.output };
    } finally {
      clones.removeBaselineCopy(copy.root);
    }
  }
  return { passed: true, head };
}

/** The Check Stages a repo's default Pipeline runs, each with what it gets there. */
export function baselineStages(config: FactoryConfig, repo: string): BaselineStage[] {
  return resolve(config, { repo, labels: [] })
    .stages.filter((s) => s.kind === "check")
    .map((s) => ({ id: s.id, commands: s.commands ?? [], network: s.network ?? [], secrets: s.secrets ?? [] }));
}
