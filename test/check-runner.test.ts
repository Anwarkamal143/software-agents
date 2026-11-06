import { mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxedCheckRunner, SandboxUnavailable, srtSandbox } from "../src/stages/check-runner.js";
import { unavailableSandbox } from "./fakes/sandbox.js";
import { tmpHome } from "./helpers/tmp.js";

/** A Factory home holding a Check Stage copy, its Attempt's temp folder, and a user home with credentials in it. */
function layout() {
  const root = realpathSync(tmpHome());
  const factoryHome = join(root, "factory");
  const userHome = join(root, "user");
  const cwd = join(factoryHome, "work", "J1", "a1", "checks", "S1");
  const tmp = join(factoryHome, "work", "J1", "a1", "tmp");
  for (const d of [cwd, tmp, join(userHome, ".ssh"), join(userHome, ".aws")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(factoryHome, "factory.yaml"), "humans: [alice]\n");
  writeFileSync(join(userHome, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  writeFileSync(join(userHome, ".aws", "credentials"), "aws_secret\n");
  writeFileSync(join(cwd, ".env"), "DB_PASSWORD=hunter2\n");
  writeFileSync(join(cwd, ".env.local"), "TOKEN=abc\n");
  return { root, factoryHome, userHome, cwd, tmp };
}

let server: Server;
let port: number;
beforeAll(async () => {
  // Something in the Orchestrator's own environment the command must never see.
  process.env.FACTORY_TEST_LEAK = "leaked";
  server = createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await srtSandbox.close();
});

describe("SandboxedCheckRunner", () => {
  test("runs every command in order in the given directory and passes when all exit 0", async () => {
    const { factoryHome, userHome, cwd } = layout();
    const runner = new SandboxedCheckRunner({ factoryHome, userHome });
    const run = await runner.run({ commands: ["echo one > out.txt", "cat out.txt", "echo two"], cwd });
    expect(run).toEqual({ passed: true, failed: null, output: "$ echo one > out.txt\n$ cat out.txt\none\n$ echo two\ntwo\n", violations: [] });
  });

  test("stops at the first failing command and reports it with its exit code", async () => {
    const { factoryHome, userHome, cwd } = layout();
    const runner = new SandboxedCheckRunner({ factoryHome, userHome });
    const run = await runner.run({ commands: ["echo ok", "echo broken >&2; exit 3", "echo never"], cwd });
    expect(run).toMatchObject({
      passed: false,
      failed: { command: "echo broken >&2; exit 3", exit_code: 3 },
      output: "$ echo ok\nok\n$ echo broken >&2; exit 3\nbroken\n",
    });
  });

  test("a command killed by its timeout fails", async () => {
    const { factoryHome, userHome, cwd } = layout();
    const runner = new SandboxedCheckRunner({ factoryHome, userHome });
    const run = await runner.run({ commands: ["sleep 5"], cwd, timeoutMs: 300 });
    expect(run.passed).toBe(false);
    expect(run.failed).toMatchObject({ command: "sleep 5", exit_code: null, timed_out: true });
  });

  test("a hostile check command can't read secrets or write outside, and reaches only allowlisted hosts", async () => {
    const { root, factoryHome, userHome, cwd, tmp } = layout();
    const runner = new SandboxedCheckRunner({ factoryHome, userHome });
    const outside = join(root, "outside.txt");
    const probe = (label: string, cmd: string) => `(${cmd}) >/dev/null 2>&1 && echo "${label}: yes" || echo "${label}: no"`;
    const run = await runner.run({
      cwd,
      env: { CHECK_SECRET: "only-this-one", TMPDIR: tmp },
      writable: [tmp],
      network: [`127.0.0.1:${port}`],
      commands: [
        [
          'echo "secret: $CHECK_SECRET"',
          'echo "orchestrator env: ${FACTORY_TEST_LEAK:-unset}"',
          probe("read .env", "cat .env"),
          probe("read .env.local", "cat .env.local"),
          probe("read ~/.ssh", `cat ${userHome}/.ssh/id_ed25519`),
          probe("read ~/.aws", `cat ${userHome}/.aws/credentials`),
          probe("read Factory home", `cat ${factoryHome}/factory.yaml`),
          probe("write outside", `echo pwned > ${outside}`),
          probe("write temp", `echo ok > ${tmp}/t.txt`),
          probe("write inside", "echo ok > artifact.txt"),
          // The Sandbox sets NO_PROXY for loopback; --noproxy '' takes the proxy route a real host would.
          probe("allowlisted host", `curl -fsS -m 5 --noproxy '' http://127.0.0.1:${port}/`),
          probe("other host", `curl -fsS -m 5 --noproxy '' http://localhost:${port}/`),
          probe("direct connection", `curl -fsS -m 5 http://127.0.0.1:${port}/`),
        ].join("; "),
      ],
    });
    expect(run.passed).toBe(true);
    expect(run.output.split("\n").slice(1, -1)).toEqual([
      "secret: only-this-one",
      "orchestrator env: unset",
      "read .env: no",
      "read .env.local: no",
      "read ~/.ssh: no",
      "read ~/.aws: no",
      "read Factory home: no",
      "write outside: no",
      "write temp: yes",
      "write inside: yes",
      "allowlisted host: yes",
      "other host: no",
      "direct connection: no",
    ]);
    expect(existsSync(outside)).toBe(false);
    expect(run.violations.some((v) => v.includes(`localhost:${port}`))).toBe(true);
  });

  test("with the sandbox unavailable, nothing runs and the run throws SandboxUnavailable", async () => {
    const { factoryHome, userHome, cwd } = layout();
    const runner = new SandboxedCheckRunner({
      factoryHome,
      userHome,
      sandbox: unavailableSandbox(),
    });
    await expect(runner.run({ commands: ["echo ran > ran.txt"], cwd })).rejects.toThrow(SandboxUnavailable);
    expect(existsSync(join(cwd, "ran.txt"))).toBe(false);
  });
});
