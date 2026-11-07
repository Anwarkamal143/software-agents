import type { Clones } from "../repos/clones.js";
import type { CheckRunner } from "../stages/check-runner.js";

export interface BaselineRequest {
  repo: string;
  /** Each Check Stage's commands, by Check Stage name, in Pipeline order. */
  checks: Record<string, string[]>;
  network: string[];
  /** Check secrets, by name, for the commands' environment. */
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
  for (const [check, commands] of Object.entries(req.checks)) {
    const copy = await clones.baselineCopy(req.repo, head);
    try {
      const run = await checks.run({
        commands,
        cwd: copy.dir,
        env: { ...req.secrets, ...copy.env },
        writable: [copy.env.HOME, copy.env.XDG_CACHE_HOME, copy.env.TMPDIR],
        network: req.network,
      });
      if (!run.passed) return { passed: false, head, check, command: run.failed!.command, exit_code: run.failed!.exit_code, output: run.output };
    } finally {
      clones.removeBaselineCopy(copy.root);
    }
  }
  return { passed: true, head };
}
