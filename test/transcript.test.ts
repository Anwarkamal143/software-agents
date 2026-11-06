import { describe, expect, test } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Transcripts } from "../src/agents/transcript.js";
import { tmpHome } from "./helpers/tmp.js";

describe("Transcripts", () => {
  test("one NDJSON file per Stage run, mode 600, under the Job's folder", async () => {
    const home = tmpHome();
    const transcript = new Transcripts(home).open("job-1", "run-1", {});
    transcript.write({ type: "system", subtype: "init", session_id: "s-1" });
    transcript.write({ type: "assistant", text: "Hello" });
    await transcript.close();

    const path = join(home, "transcripts", "job-1", "run-1.ndjson");
    expect(readFileSync(path, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l))).toEqual([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", text: "Hello" },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a planted secret value echoed by the agent is redacted before it is written", async () => {
    const home = tmpHome();
    const secrets = { STRIPE_KEY: "sk_live_planted_123", GITHUB_APP_KEY: 'line1\n"quoted"\\line2' };
    const transcript = new Transcripts(home).open("job-1", "run-1", secrets);
    transcript.write({ type: "tool_result", content: "STRIPE=sk_live_planted_123 and again sk_live_planted_123" });
    transcript.write({ type: "assistant", text: `The key is ${secrets.GITHUB_APP_KEY}.` });
    await transcript.close();

    const text = readFileSync(join(home, "transcripts", "job-1", "run-1.ndjson"), "utf8");
    expect(text).not.toContain("sk_live_planted_123");
    expect(text).not.toContain("quoted");
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].content).toBe("STRIPE=[redacted:STRIPE_KEY] and again [redacted:STRIPE_KEY]");
    expect(lines[1].text).toBe("The key is [redacted:GITHUB_APP_KEY].");
  });

  test("a value too short to be a secret isn't redacted, so ordinary words survive", async () => {
    const home = tmpHome();
    const transcript = new Transcripts(home).open("job-1", "run-1", { FLAG: "1", EMPTY: "" });
    transcript.write({ text: "1 file changed" });
    await transcript.close();
    expect(readFileSync(join(home, "transcripts", "job-1", "run-1.ndjson"), "utf8")).toContain("1 file changed");
  });
});
