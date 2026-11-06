import { existsSync, readFileSync } from "node:fs";
import { Transcripts } from "../agents/transcript.js";
import type { FactoryEvent } from "../events/envelope.js";
import type { JobStore } from "../store/job-store.js";

const STARTS = new Set(["stage-started", "stage-resumed"]);
const ENDS = new Set(["stage-passed", "stage-failed", "stage-needs-human", "stage-errored", "stage-interrupted", "prepush-failed"]);

/**
 * `factory logs <job>`: one Job's events, each Stage run's Transcript under the event that
 * started it (ADR 0009). With `follow`, carries on with new events and the live Transcript
 * until `signal` aborts. Reads only; the Transcript is already redacted on disk.
 */
export async function printLogs(store: JobStore, home: string, job_id: string, write: (s: string) => void, opts: { follow?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const transcripts = new Transcripts(home);
  /** Stage runs whose Transcript is being read, and how far. */
  const tails = new Map<string, number>();
  const drain = (run: string) => {
    const path = transcripts.path(job_id, run);
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const from = tails.get(run) ?? 0;
    // Only whole lines: a line still being written is read next time.
    const end = text.lastIndexOf("\n") + 1;
    if (end <= from) return;
    for (const line of text.slice(from, end).split("\n").filter(Boolean)) {
      for (const shown of describeMessage(line)) write(`  │ ${shown}\n`);
    }
    tails.set(run, end);
  };
  const show = (e: FactoryEvent) => {
    if (e.job_id !== job_id) return;
    const run = e.stage_run_id;
    if (run && ENDS.has(e.type) && tails.has(run)) {
      drain(run);
      tails.delete(run);
    }
    const stage = typeof e.data.stage === "string" ? ` ${e.data.stage}` : "";
    write(`${e.at} ${e.type}${stage}\n`);
    if (run && STARTS.has(e.type)) {
      tails.set(run, 0);
      drain(run);
    }
  };

  if (!opts.follow) {
    for (const e of store.read()) show(e);
    for (const run of tails.keys()) drain(run);
    return;
  }
  const timer = setInterval(() => {
    for (const run of tails.keys()) drain(run);
  }, 200);
  try {
    for await (const e of store.follow(1, { ...(opts.signal && { signal: opts.signal }), pollMs: 200 })) show(e);
  } finally {
    clearInterval(timer);
  }
}

/** One Transcript line as a few words each: what the agent said, ran and got back. */
function describeMessage(line: string): string[] {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const cap = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s).replace(/\s+/g, " ").trim();
  if (m.type === "system" && m.subtype === "init") return [`session ${String(m.session_id)} started`];
  if (m.type === "result") return [`session ended: ${String(m.subtype)}${typeof m.total_cost_usd === "number" ? ` (est. $${m.total_cost_usd.toFixed(2)})` : ""}`];
  if (m.type === "rate_limit_event") return [`rate limit: ${String((m.rate_limit_info as { status?: string } | undefined)?.status)}`];
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (m.type === "assistant" && c.type === "text") out.push(`agent: ${cap(String(c.text))}`);
    if (c.type === "tool_use") {
      const input = (c.input ?? {}) as Record<string, unknown>;
      const what = input.command ?? input.file_path ?? input.pattern ?? input.path ?? "";
      out.push(`tool: ${String(c.name)}${what ? ` ${cap(String(what))}` : ""}`);
    }
    if (c.type === "tool_result") out.push(`result: ${cap(typeof c.content === "string" ? c.content : JSON.stringify(c.content))}`);
  }
  return out;
}
