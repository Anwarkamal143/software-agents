import { describe, expect, test } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentRunRequest } from "../src/agents/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude.js";
import { srtSandbox } from "../src/stages/check-runner.js";
import { STAGE_RESULT_SCHEMA } from "../src/stages/result.js";
import { tmpHome } from "./helpers/tmp.js";

/**
 * The fail-closed case the SDK isolation prototype couldn't exercise on macOS: on Linux without
 * bubblewrap the real Sandbox self-check fails, and no session starts. Runs on Linux (CI), with
 * PATH pointed at a folder that has `which` and nothing else, so bubblewrap can't be found.
 */
describe.runIf(process.platform === "linux")("Claude adapter on Linux without bubblewrap", () => {
  test("fails instead of running unsandboxed", async () => {
    const home = tmpHome();
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync(execFileSync("sh", ["-c", "command -v which"], { encoding: "utf8" }).trim(), join(bin, "which"));
    const wc = join(home, "wc");
    let queried = false;
    const adapter = new ClaudeAdapter({
      home,
      signIn: "subscription",
      pluginDir: home,
      sandbox: srtSandbox,
      query: () => {
        queried = true;
        return (async function* () {})();
      },
    });
    const path = process.env.PATH;
    process.env.PATH = bin;
    let outcome;
    try {
      outcome = await adapter.run({
        job_id: "job-1",
        stage_run_id: "run-1",
        brief: { stage: "build", tools: "write-branch" } as AgentRunRequest["brief"],
        renderedBrief: "x",
        model: "claude-haiku-5-5",
        workingCopy: { dir: wc, env: { HOME: wc, XDG_CONFIG_HOME: wc, XDG_CACHE_HOME: wc, npm_config_cache: wc, TMPDIR: wc }, objects: join(wc, "objects") },
        network: [],
        budget: { usd: 0.1, turns: 1, minutes: 1 },
        resultSchema: STAGE_RESULT_SCHEMA,
        events: { activity() {}, session() {}, guardBlocked() {}, rateLimit() {} },
      });
    } finally {
      process.env.PATH = path;
    }
    expect(outcome).toMatchObject({ kind: "fault", reason: "sandbox-unavailable" });
    expect(queried).toBe(false);
  });
});
