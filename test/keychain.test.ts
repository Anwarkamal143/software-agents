import { describe, expect, test } from "vitest";
import { OsKeychain, type RunSecurityTool } from "../src/secrets/keychain.js";

/** Records each call to the OS keychain tool and keeps what it was given, like the real keychain. */
function fakeTool() {
  const calls: { file: string; args: string[]; stdin: string }[] = [];
  const stored = new Map<string, string>();
  const run: RunSecurityTool = async (file, args, stdin = "") => {
    calls.push({ file, args, stdin });
    if (file === "security" && args[0] === "-i") {
      const m = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(stdin);
      if (!m) return { code: 1, stdout: "" };
      stored.set(m[2]!, m[3]!);
      return { code: 0, stdout: "" };
    }
    if (file === "security" && args[0] === "find-generic-password") {
      const v = stored.get(args[args.indexOf("-a") + 1]!);
      return v === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${v}\n` };
    }
    if (file === "secret-tool" && args[0] === "store") {
      stored.set(args.at(-1)!, stdin);
      return { code: 0, stdout: "" };
    }
    const v = stored.get(args.at(-1)!);
    return v === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: v };
  };
  return { run, calls };
}

describe("OsKeychain", () => {
  test.each(["darwin", "linux"] as const)("on %s, set sends the value over stdin, never in the command's arguments", async (platform) => {
    const tool = fakeTool();
    const keychain = new OsKeychain("software-factory", { platform, run: tool.run });

    await keychain.set("DATABASE_URL", "postgres://u:pw@db/app");

    for (const c of tool.calls) expect(c.args.join(" ")).not.toContain("pw@db");
    expect(tool.calls.map((c) => c.stdin).join("")).not.toBe("");
    expect(await keychain.get("DATABASE_URL")).toBe("postgres://u:pw@db/app");
  });

  test("a multi-line value, such as the App's private key, comes back exactly as set", async () => {
    const keychain = new OsKeychain("software-factory", { platform: "darwin", run: fakeTool().run });
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n";
    await keychain.set("GITHUB_APP_PRIVATE_KEY", pem);
    expect(await keychain.get("GITHUB_APP_PRIVATE_KEY")).toBe(pem);
  });

  test("a name that isn't a plain identifier is refused", async () => {
    const keychain = new OsKeychain("software-factory", { platform: "darwin", run: fakeTool().run });
    await expect(keychain.set("A -w x", "v")).rejects.toThrow(/name/);
  });
});
