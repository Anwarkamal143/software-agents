import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { SandboxUnavailable, srtSandbox } from "../src/stages/check-runner.js";
import { building, ScriptedAgent } from "./fakes/agent.js";
import { approved } from "./fakes/source.js";
import { fakeFactory } from "./helpers/factory.js";
import { tmpHome } from "./helpers/tmp.js";

afterAll(() => srtSandbox.close());

/**
 * The real Sandbox failing closed on Linux (#43): the Factory pauses with `sandbox-unavailable`
 * and starts no Stage run. CI runs these on ubuntu; the restricted-namespaces case runs in its own
 * job, on a runner whose AppArmor still restricts unprivileged user namespaces.
 */
describe.runIf(process.platform === "linux")("the real Sandbox on Linux", () => {
  test("with bubblewrap missing, the Factory pauses before any Stage run, and goes on once it's back", async () => {
    const f = fakeFactory(new ScriptedAgent({ build: [building] }));
    // A PATH with `which` and nothing else, so bubblewrap can't be found.
    const bin = join(tmpHome(), "bin");
    mkdirSync(bin);
    symlinkSync(execFileSync("sh", ["-c", "command -v which"], { encoding: "utf8" }).trim(), join(bin, "which"));
    const path = process.env.PATH;
    process.env.PATH = bin;
    try {
      await f.orchestrator.start();
    } finally {
      process.env.PATH = path;
    }
    expect(f.log.factoryPause()).toMatchObject({ type: "factory-paused", data: { reason: "sandbox-unavailable", message: expect.stringContaining("bubblewrap (bwrap) not installed") } });

    f.source.push(approved(7));
    await f.orchestrator.runUntilIdle();
    expect(f.log.store.read().some((e) => e.type === "factory-resumed")).toBe(true);
    expect(f.agent.stagesRun()).toContain("build");
  });

  test.runIf(process.env.FACTORY_EXPECT_USERNS_RESTRICTED === "1")(
    "with unprivileged user namespaces restricted, the Sandbox reports unavailable and nothing runs",
    async () => {
      await expect(srtSandbox.ready()).rejects.toThrow(SandboxUnavailable);
      await expect(srtSandbox.ready()).rejects.toThrow(/user namespaces/);

      const f = fakeFactory(new ScriptedAgent({ build: [building] }));
      f.source.push(approved(7));
      await f.orchestrator.start();
      await f.orchestrator.runUntilIdle();
      expect(f.log.factoryPause()).toMatchObject({ data: { reason: "sandbox-unavailable" } });
      expect(f.agent.stagesRun()).toEqual([]);
      expect(f.onlyJob()).toMatchObject({ status: "paused", reason: "factory-paused" });
    },
  );
});
