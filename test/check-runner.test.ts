import { describe, expect, test } from "vitest";
import { ShellCheckRunner } from "../src/stages/check-runner.js";
import { tmpHome } from "./helpers/tmp.js";

const runner = new ShellCheckRunner();

describe("ShellCheckRunner", () => {
  test("runs every command in order in the given directory and passes when all exit 0", async () => {
    const cwd = tmpHome();
    const run = await runner.run({ commands: ["echo one > out.txt", "cat out.txt", "echo two"], cwd });
    expect(run).toEqual({ passed: true, failed: null, output: "$ echo one > out.txt\n$ cat out.txt\none\n$ echo two\ntwo\n" });
  });

  test("stops at the first failing command and reports it with its exit code", async () => {
    const run = await runner.run({ commands: ["echo ok", "echo broken >&2; exit 3", "echo never"], cwd: tmpHome() });
    expect(run).toEqual({
      passed: false,
      failed: { command: "echo broken >&2; exit 3", exit_code: 3 },
      output: "$ echo ok\nok\n$ echo broken >&2; exit 3\nbroken\n",
    });
  });

  test("a command killed by its timeout fails", async () => {
    const run = await runner.run({ commands: ["sleep 5"], cwd: tmpHome(), timeoutMs: 100 });
    expect(run.passed).toBe(false);
    expect(run.failed).toMatchObject({ command: "sleep 5", exit_code: null, timed_out: true });
  });
});
