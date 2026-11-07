import { describe, expect, test } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunEvents, AgentRunRequest, GuardDenial, RateLimitInfo } from "../src/agents/adapter.js";
import { ClaudeAdapter, FACTORY_PLUGIN_DIR, type QueryFn } from "../src/agents/claude.js";
import type { Sandbox } from "../src/stages/check-runner.js";
import { STAGE_RESULT_SCHEMA } from "../src/stages/result.js";
import { unavailableSandbox } from "./fakes/sandbox.js";
import { tmpHome } from "./helpers/tmp.js";

const readySandbox: Sandbox = { ready: async () => {}, wrap: () => Promise.reject(new Error("unused")), close: async () => {} };

/** What a session reported to the Orchestrator. */
function recorder() {
  const seen = { activity: 0, sessions: [] as string[], denials: [] as GuardDenial[], rateLimits: [] as RateLimitInfo[] };
  const events: AgentRunEvents = {
    activity: () => void seen.activity++,
    session: (id) => void seen.sessions.push(id),
    guardBlocked: (d) => void seen.denials.push(d),
    rateLimit: (i) => void seen.rateLimits.push(i),
  };
  return { seen, events };
}

const init = (apiKeySource = "none"): SDKMessage => ({ type: "system", subtype: "init", session_id: "s-1", apiKeySource } as unknown as SDKMessage);
const success = (structured_output: unknown, over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s-1",
    total_cost_usd: 0.12,
    num_turns: 4,
    duration_ms: 3400,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    structured_output,
    ...over,
  }) as unknown as SDKMessage;
const failure = (subtype: string, over: Record<string, unknown> = {}): SDKMessage =>
  ({ type: "result", subtype, is_error: true, session_id: "s-1", total_cost_usd: 1, num_turns: 9, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, errors: ["boom"], ...over }) as unknown as SDKMessage;
const RESULT = { verdict: "pass", summary: "Done.", findings: [], artifacts: [] };

/** A fake `query()` that records its call and, between messages, runs `during` against the options. */
function fakeQuery(messages: SDKMessage[], during?: (options: Options) => Promise<void>) {
  const calls: { prompt: unknown; options: Options }[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options: options! });
    return (async function* () {
      for (const [i, m] of messages.entries()) {
        if (i === 1 && during) await during(options!);
        yield m;
      }
    })();
  };
  return { query, calls };
}

function setup(opts: { signIn?: "api-key" | "subscription"; secrets?: Record<string, string>; sandbox?: Sandbox; env?: Record<string, string> } = {}) {
  const home = tmpHome();
  const wc = join(home, "work", "job-1", "a1");
  const env = { HOME: join(wc, "home"), XDG_CONFIG_HOME: join(wc, "home", ".config"), XDG_CACHE_HOME: join(wc, "cache"), npm_config_cache: join(wc, "cache", "npm"), TMPDIR: join(wc, "tmp") };
  mkdirSync(join(wc, "repo"), { recursive: true });
  const { seen, events } = recorder();
  const request: AgentRunRequest = {
    job_id: "job-1",
    stage_run_id: "run-1",
    brief: { stage: "build", instructions: "factory:build", tools: "write-branch" } as AgentRunRequest["brief"],
    renderedBrief: "Build the thing.",
    model: "claude-opus-5-5",
    workingCopy: { dir: join(wc, "repo"), env },
    network: ["registry.npmjs.org"],
    budget: { usd: 5, turns: 100, minutes: 30 },
    resultSchema: STAGE_RESULT_SCHEMA,
    events,
  };
  const make = (query: QueryFn) =>
    new ClaudeAdapter({
      home,
      signIn: opts.signIn ?? "subscription",
      apiKey: async () => "sk-ant-api-key-from-keychain",
      pluginDir: FACTORY_PLUGIN_DIR,
      secrets: async () => opts.secrets ?? {},
      sandbox: opts.sandbox ?? readySandbox,
      userHome: "/Users/me",
      baseEnv: { PATH: "/usr/bin:/bin", USER: "me", ANTHROPIC_API_KEY: "sk-ant-stray", ANTHROPIC_AUTH_TOKEN: "stray", AWS_SECRET_ACCESS_KEY: "aws", LANG: "en_US.UTF-8", ...opts.env },
      query,
    });
  return { home, request, seen, make, wc };
}

describe("Claude adapter: session options", () => {
  test("a hostile Target repo's settings, hooks, MCP servers and memory are all kept out", async () => {
    const s = setup();
    const { query, calls } = fakeQuery([init(), success(RESULT)]);
    await s.make(query).run(s.request);

    const o = calls[0]!.options;
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.managedSettings).toMatchObject({ disableAllHooks: true });
    expect(o.cwd).toBe(s.request.workingCopy.dir);
    expect(o.plugins).toEqual([{ type: "local", path: FACTORY_PLUGIN_DIR }]);
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.maxTurns).toBe(100);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.permissionMode).toBe("default");
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: STAGE_RESULT_SCHEMA });
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(calls[0]!.prompt).toBe("Build the thing.");
  });

  test("the session gets an allowlisted minimal environment; in subscription mode no API key gets in", async () => {
    const s = setup({ signIn: "subscription" });
    const { query, calls } = fakeQuery([init("none"), success(RESULT)]);
    await s.make(query).run(s.request);

    const env = calls[0]!.options.env!;
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.PATH).toBe("/usr/bin:/bin");
    // Claude Code finds the subscription login in the macOS keychain by USER.
    expect(env.USER).toBe("me");
    expect(env.TMPDIR).toBe(s.request.workingCopy.env.TMPDIR);
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY"]) expect(env).not.toHaveProperty(key);
    // The subscription login lives in your own HOME; caches stay the Attempt's.
    expect(env.HOME).toBe("/Users/me");
    expect(env.XDG_CACHE_HOME).toBe(s.request.workingCopy.env.XDG_CACHE_HOME);
  });

  test("in API-key mode the key comes from the keychain, not the shell, and HOME is the Attempt's", async () => {
    const s = setup({ signIn: "api-key" });
    const { query, calls } = fakeQuery([init("ANTHROPIC_API_KEY"), success(RESULT)]);
    await s.make(query).run(s.request);

    const env = calls[0]!.options.env!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-key-from-keychain");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env.HOME).toBe(s.request.workingCopy.env.HOME);
  });

  test("the Sandbox is on, fails closed, writes only in the Working copy and reaches only the Stage's hosts", async () => {
    const s = setup();
    const { query, calls } = fakeQuery([init(), success(RESULT)]);
    await s.make(query).run(s.request);

    const sandbox = calls[0]!.options.sandbox!;
    expect(sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], strictAllowlist: true });
    expect(sandbox.filesystem?.allowWrite).toEqual([s.request.workingCopy.dir, s.request.workingCopy.env.TMPDIR, s.request.workingCopy.env.XDG_CACHE_HOME]);
    expect(sandbox.filesystem?.denyRead).toEqual(expect.arrayContaining([s.home, "/Users/me/.ssh", "/Users/me/.claude"]));
  });

  test("a read-only Stage can't write the Working copy and gets no network", async () => {
    const s = setup();
    const { query, calls } = fakeQuery([init(), success(RESULT)]);
    await s.make(query).run({ ...s.request, brief: { ...s.request.brief, tools: "read-only" }, network: ["registry.npmjs.org"] });

    const o = calls[0]!.options;
    expect(o.allowedTools).not.toContain("Write");
    expect(o.allowedTools).not.toContain("Edit");
    expect(o.sandbox!.filesystem?.allowWrite).toEqual([s.request.workingCopy.env.TMPDIR]);
    expect(o.sandbox!.network).toEqual({ allowedDomains: [], strictAllowlist: true });
  });
});

describe("Claude adapter: sign-in, Guards and the network", () => {
  test("a session whose apiKeySource doesn't match the sign-in mode is a Factory fault", async () => {
    const s = setup({ signIn: "subscription" });
    const { query } = fakeQuery([init("apiKeyHelper"), success(RESULT)]);
    const outcome = await s.make(query).run(s.request);
    expect(outcome).toMatchObject({ kind: "fault", reason: "sign-in-mismatch" });
    expect((outcome as { message: string }).message).toMatch(/apiKeyHelper/);
  });

  test("Guards run as a PreToolUse callback on every tool call, and a denied .env read is reported", async () => {
    const s = setup();
    const decisions: unknown[] = [];
    const { query } = fakeQuery([init(), success(RESULT)], async (o) => {
      const hook = o.hooks!.PreToolUse![0]!.hooks[0]!;
      const call = (tool_name: string, tool_input: unknown) =>
        hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s-1", transcript_path: "", cwd: "" }, "t", { signal: new AbortController().signal });
      decisions.push(await call("Read", { file_path: ".env" }));
      decisions.push(await call("Read", { file_path: "src/app.ts" }));
    });
    await s.make(query).run(s.request);

    expect(decisions[0]).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(decisions[1]).toEqual({});
    expect(s.seen.denials).toEqual([{ guard: "secret-file", tool: "Read", why: ".env is a secret file" }]);
  });

  test("canUseTool denies every SandboxNetworkAccess ask", async () => {
    const s = setup();
    let decision: unknown;
    const { query } = fakeQuery([init(), success(RESULT)], async (o) => {
      decision = await o.canUseTool!("SandboxNetworkAccess", { host: "example.com" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
    });
    await s.make(query).run(s.request);
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  test("when the Sandbox can't start, no session runs: a Factory fault", async () => {
    const s = setup({ sandbox: unavailableSandbox() });
    const { query, calls } = fakeQuery([init(), success(RESULT)]);
    const outcome = await s.make(query).run(s.request);
    expect(outcome).toMatchObject({ kind: "fault", reason: "sandbox-unavailable", message: "bubblewrap is not installed" });
    expect(calls).toHaveLength(0);
  });
});

describe("Claude adapter: results and errors", () => {
  test("structured_output is the Stage result; cost, tokens, turns and duration are reported", async () => {
    const s = setup();
    const { query } = fakeQuery([init(), success(RESULT)]);
    const outcome = await s.make(query).run(s.request);
    expect(outcome).toEqual({
      kind: "output",
      output: RESULT,
      session_id: "s-1",
      facts: { cost_usd: 0.12, tokens: 1250, turns: 4, duration_ms: 3400, head: null, files_changed: [] },
    });
    expect(s.seen.sessions).toEqual(["s-1"]);
    expect(s.seen.activity).toBe(2);
  });

  test.each([
    ["error_max_turns", "budget"],
    ["error_max_budget_usd", "budget"],
    ["error_during_execution", "sdk-error"],
  ])("a %s result is a %s Run error", async (subtype, reason) => {
    const s = setup();
    const { query } = fakeQuery([init(), failure(subtype)]);
    expect(await s.make(query).run(s.request)).toMatchObject({ kind: "error", reason, session_id: "s-1", facts: { cost_usd: 1, turns: 9 } });
  });

  test("failing structured-output retries is a result that doesn't fit the schema", async () => {
    const s = setup();
    const { query } = fakeQuery([init(), failure("error_max_structured_output_retries")]);
    expect(await s.make(query).run(s.request)).toMatchObject({ kind: "output", output: null });
  });

  test("an API overload is a transient error", async () => {
    const s = setup();
    const { query } = fakeQuery([init(), failure("error_during_execution", { api_error_status: 529 })]);
    expect(await s.make(query).run(s.request)).toMatchObject({ kind: "error", reason: "sdk-error", transient: true });
  });

  test("a session that throws is a crash", async () => {
    const s = setup();
    const query: QueryFn = () =>
      (async function* () {
        yield init();
        throw new Error("Claude Code process exited with code 1");
      })();
    expect(await s.make(query).run(s.request)).toMatchObject({ kind: "error", reason: "crash", message: expect.stringMatching(/exited with code 1/), session_id: "s-1" });
  });

  test("resuming sends the input as the next turn of that session; a session that's gone is a failed resume", async () => {
    const s = setup();
    const { query, calls } = fakeQuery([init(), success(RESULT)]);
    await s.make(query).run({ ...s.request, resume: { session_id: "s-0", input: "Carry on." } });
    expect(calls[0]!.options.resume).toBe("s-0");
    expect(calls[0]!.prompt).toBe("Carry on.");

    const gone: QueryFn = () =>
      (async function* () {
        yield* [];
        throw new Error("No conversation found with session ID: s-0");
      })();
    expect(await s.make(gone).run({ ...s.request, resume: { session_id: "s-0", input: "Carry on." } })).toMatchObject({ kind: "resume-failed" });
  });

  test("a rate_limit_event is reported with resetsAt as a time", async () => {
    const s = setup();
    const event = { type: "rate_limit_event", session_id: "s-1", rate_limit_info: { status: "rejected", resetsAt: 1_794_000_000, utilization: 1 } } as unknown as SDKMessage;
    const { query } = fakeQuery([init(), event, success(RESULT)]);
    await s.make(query).run(s.request);
    expect(s.seen.rateLimits).toEqual([{ status: "rejected", utilization: 1, resets_at: new Date(1_794_000_000 * 1000).toISOString() }]);
  });

  test("aborting the Orchestrator's signal aborts the session", async () => {
    const s = setup();
    const controller = new AbortController();
    let sessionSignal: AbortSignal | undefined;
    const { query } = fakeQuery([init(), success(RESULT)], async (o) => {
      sessionSignal = o.abortController!.signal;
      controller.abort("idle");
    });
    await s.make(query).run({ ...s.request, signal: controller.signal });
    expect(sessionSignal?.aborted).toBe(true);
  });

  test("every message goes to the Transcript, with Factory credential and check-secret values redacted", async () => {
    const s = setup({ secrets: { DATABASE_URL: "postgres://u:planted-pw@db/x" } });
    const echoed = { type: "assistant", session_id: "s-1", message: { content: [{ type: "text", text: "The URL is postgres://u:planted-pw@db/x" }] } } as unknown as SDKMessage;
    const { query } = fakeQuery([init(), echoed, success(RESULT)]);
    await s.make(query).run(s.request);

    const text = readFileSync(join(s.home, "transcripts", "job-1", "run-1.ndjson"), "utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(3);
    expect(text).not.toContain("planted-pw");
    expect(text).toContain("[redacted:DATABASE_URL]");
  });
});
