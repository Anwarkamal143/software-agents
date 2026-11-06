import { describe, expect, test } from "vitest";
import { OsNotifier } from "../src/humans/notify.js";

describe("OsNotifier", () => {
  const recorder = () => {
    const runs: [string, string[]][] = [];
    return { runs, run: async (cmd: string, args: string[]) => void runs.push([cmd, args]) };
  };

  test("on macOS the text goes to osascript as arguments, never into the script", async () => {
    const r = recorder();
    await new OsNotifier("darwin", r.run).notify({ title: "Factory: acme/web-app#7 needs you", body: 'He said "hi" & end run' });
    expect(r.runs).toEqual([
      ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "Factory: acme/web-app#7 needs you", 'He said "hi" & end run']],
    ]);
  });

  test("on Linux it uses notify-send, with options ended before the text, and caps the body", async () => {
    const r = recorder();
    await new OsNotifier("linux", r.run).notify({ title: "-t", body: "x".repeat(500) });
    expect(r.runs).toEqual([["notify-send", ["--", "-t", "x".repeat(200)]]]);
  });
});
