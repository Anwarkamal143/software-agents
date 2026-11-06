import { describe, expect, test } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli/run.js";
import { openSqliteJobStore } from "../src/store/sqlite-job-store.js";
import { tmpHome } from "./helpers/tmp.js";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function home() {
  const dir = tmpHome();
  const store = openSqliteJobStore(join(dir, "factory.db"));
  store.append({ type: "job-approved", job_id: "job-1", actor: "human:alice", data: { repo: "acme/web-app", issue: 7 } });
  store.append({ type: "attempt-started", job_id: "job-1", attempt: 1, actor: "orchestrator", data: { branch: "factory/7" } });
  store.append({ type: "stage-started", job_id: "job-1", attempt: 1, stage_run_id: "run-1", actor: "orchestrator", data: { stage: "triage" } });
  store.append({ type: "job-approved", job_id: "job-2", actor: "human:alice", data: { repo: "acme/web-app", issue: 8 } });
  const transcripts = join(dir, "transcripts", "job-1");
  mkdirSync(transcripts, { recursive: true });
  const transcript = join(transcripts, "run-1.ndjson");
  writeFileSync(
    transcript,
    [
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Looking at the issue." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    ]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join(""),
  );
  return { dir, store, transcript };
}

async function cli(dir: string, argv: string[], signal?: AbortSignal) {
  let stdout = "";
  const io = { home: dir, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: (s: string) => void (stdout += s) }, ...(signal && { signal }) };
  const done = runCli(argv, io);
  return { done, out: () => stdout };
}

describe("factory logs", () => {
  test("prints one Job's events with each Stage run's Transcript under the event that started it", async () => {
    const h = home();
    h.store.append({ type: "stage-passed", job_id: "job-1", attempt: 1, stage_run_id: "run-1", actor: "stage:triage", data: { stage: "triage", cost_usd: 0.1 } });
    const { done, out } = await cli(h.dir, ["logs", "job-1"]);
    expect(await done).toBe(0);
    const lines = out().trimEnd().split("\n");
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual([
      "job-approved",
      "attempt-started",
      "stage-started triage",
      "  │ session s-1 started",
      "  │ agent: Looking at the issue.",
      "  │ tool: Bash npm test",
      "stage-passed triage",
    ]);
    expect(out()).not.toContain("job-2");
  });

  test("--follow keeps printing new events and the live Transcript until stopped", async () => {
    const h = home();
    const stop = new AbortController();
    const { done, out } = await cli(h.dir, ["logs", "job-1", "--follow"], stop.signal);
    await tick(100);
    expect(out()).toContain("agent: Looking at the issue.");

    appendFileSync(h.transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tests pass." }] } })}\n`);
    await tick(800);
    expect(out()).toContain("agent: Tests pass.");

    h.store.append({ type: "stage-passed", job_id: "job-1", attempt: 1, stage_run_id: "run-1", actor: "stage:triage", data: { stage: "triage" } });
    await tick(800);
    expect(out()).toContain("stage-passed triage");

    stop.abort();
    expect(await done).toBe(0);
  });
});
