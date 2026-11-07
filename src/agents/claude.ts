import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery, type CanUseTool, type HookCallback, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolProfile } from "../config/types.js";
import { SandboxUnavailable, srtSandbox, type Sandbox } from "../stages/check-runner.js";
import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, MeasuredFacts } from "./adapter.js";
import { checkToolCall } from "./guards.js";
import { stageInstructions } from "./plugin.js";
import { Transcripts } from "./transcript.js";

export { FACTORY_PLUGIN_DIR } from "./plugin.js";

/** The SDK's `query()`, or a stand-in that yields the same messages. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAdapterOptions {
  /** The Factory home: Transcripts go here, and no session may read it. */
  home: string;
  /** The configured sign-in mode (a Factory-wide value). */
  signIn: "api-key" | "subscription";
  /** API-key mode: the key, read from the keychain by the Orchestrator. */
  apiKey?: () => Promise<string | null>;
  /** The Factory plugin: Stage instructions only, no hooks (ADR 0007). */
  pluginDir: string;
  /** Exact values never to write to a Transcript, by name: Factory credentials and check secrets (ADR 0009). */
  secrets?: () => Promise<Record<string, string>>;
  /** Checked before every session: the Factory never runs one unsandboxed (ADR 0007). */
  sandbox?: Sandbox;
  userHome?: string;
  /** Where PATH and the locale come from. Nothing else of it reaches the session. */
  baseEnv?: NodeJS.ProcessEnv;
  query?: QueryFn;
}

/** Tools per Tool profile. Every other tool needs `canUseTool`, which denies it. */
const TOOLS: Record<ToolProfile, string[]> = {
  "read-only": ["Read", "Glob", "Grep", "Bash", "TodoWrite"],
  "write-branch": ["Read", "Glob", "Grep", "Bash", "TodoWrite", "Write", "Edit", "MultiEdit", "NotebookEdit"],
};
/** Never, whatever the profile: no web access and no agents of the agent's own (ADR 0007). */
const DISALLOWED = ["WebFetch", "WebSearch", "Task", "Agent"];

/** Home-directory credential folders no session's commands may read. `.claude` holds the subscription login. */
const HOME_CREDENTIALS = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube", ".netrc", ".npmrc", ".git-credentials", ".claude"];

/**
 * The only variables a session inherits from the Orchestrator's own environment. `USER` and
 * `LOGNAME` are how Claude Code finds a subscription login in the macOS keychain.
 */
const INHERITED = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];

/** What `system/init` says about the credential for each sign-in mode. */
const EXPECTED_KEY_SOURCE = { "api-key": "ANTHROPIC_API_KEY", subscription: "none" } as const;

/** Statuses an API error is transient for: overloaded, server errors, rate limits (ADR 0010). */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const TRANSIENT_ERRORS = new Set(["overloaded", "server_error", "rate_limit"]);

/**
 * The Claude Agent SDK as the Agent adapter (ADR 0001), configured on the assumption that the
 * agent is compromised (ADR 0007): no Target repo settings, hooks, MCP servers or memory; a
 * minimal environment; the SDK Sandbox, failing closed, with a strict network allowlist; Guards
 * as `PreToolUse` callbacks; and `canUseTool` denying every ask. Never `bypassPermissions`,
 * `claude -p` or `--safe-mode`.
 */
export class ClaudeAdapter implements AgentAdapter {
  private readonly query: QueryFn;
  private readonly sandbox: Sandbox;
  private readonly transcripts: Transcripts;
  private readonly userHome: string;

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.query = options.query ?? ((params) => sdkQuery(params));
    this.sandbox = options.sandbox ?? srtSandbox;
    this.transcripts = new Transcripts(options.home);
    this.userHome = options.userHome ?? homedir();
  }

  async run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    // The self-check comes first: on a host the Sandbox can't confine, nothing runs (ADR 0007).
    try {
      await this.sandbox.ready();
    } catch (err) {
      if (err instanceof SandboxUnavailable) return { kind: "fault", reason: "sandbox-unavailable", message: err.message };
      throw err;
    }
    const env = await this.env(request);
    if (env === null) return { kind: "fault", reason: "sign-in-mismatch", message: "API-key sign-in is configured, but no API key is in the keychain." };

    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const transcript = this.transcripts.open(request.job_id, request.stage_run_id, { ...(await this.options.secrets?.()), ...(env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }) });

    let session_id: string | undefined;
    let transient = false;
    const started = Date.now();
    try {
      const options = { ...sessionOptions(request, { home: this.options.home, userHome: this.userHome, pluginDir: this.options.pluginDir, env }), abortController: controller };
      const prompt = request.resume ? request.resume.input : request.renderedBrief;
      for await (const message of this.query({ prompt, options: request.resume ? { ...options, resume: request.resume.session_id } : options })) {
        request.events.activity();
        transcript.write(message);
        if (message.type === "system" && message.subtype === "init") {
          session_id = message.session_id;
          request.events.session(message.session_id);
          const expected = EXPECTED_KEY_SOURCE[this.options.signIn];
          if (message.apiKeySource !== expected) {
            controller.abort("sign-in-mismatch");
            return {
              kind: "fault",
              reason: "sign-in-mismatch",
              message: `The session signed in with ${message.apiKeySource}, but ${this.options.signIn} sign-in is configured (expected apiKeySource ${expected}).`,
            };
          }
        }
        if (message.type === "assistant" && message.error && TRANSIENT_ERRORS.has(message.error)) transient = true;
        if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          request.events.rateLimit({
            status: info.status,
            ...(info.utilization !== undefined && { utilization: info.utilization }),
            ...(info.resetsAt !== undefined && { resets_at: new Date(info.resetsAt * 1000).toISOString() }),
          });
        }
        if (message.type === "result") return this.outcome(message, transient, Date.now() - started);
      }
      return { kind: "error", reason: "crash", message: "The session ended without a result.", facts: facts({ duration_ms: Date.now() - started }), ...(session_id && { session_id }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (request.resume && !session_id && /no conversation found|session.*not found/i.test(message)) return { kind: "resume-failed", message };
      if (/sandbox/i.test(message) && /unavailable|cannot start|not available|failed to start/i.test(message)) return { kind: "fault", reason: "sandbox-unavailable", message };
      return { kind: "error", reason: "crash", message, facts: facts({ duration_ms: Date.now() - started }), ...(session_id && { session_id }) };
    } finally {
      request.signal?.removeEventListener("abort", abort);
      transcript.close();
    }
  }

  private outcome(result: Extract<SDKMessage, { type: "result" }>, transient: boolean, elapsed: number): AgentRunOutcome {
    const usage = result.usage as unknown as Record<string, number> | undefined;
    const tokens = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce((n, k) => n + (usage?.[k] ?? 0), 0);
    const measured = facts({ cost_usd: result.total_cost_usd ?? 0, tokens, turns: result.num_turns ?? 0, duration_ms: result.duration_ms ?? elapsed });
    const session_id = result.session_id;
    if (result.subtype === "success") return { kind: "output", output: result.structured_output ?? null, facts: measured, session_id };
    // The session couldn't produce output that fits: the Orchestrator's schema check says why.
    if (result.subtype === "error_max_structured_output_retries") return { kind: "output", output: null, facts: measured, session_id };
    const errors = "errors" in result && Array.isArray(result.errors) ? result.errors.join("; ") : "";
    if (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd") {
      return { kind: "error", reason: "budget", message: `${result.subtype}${errors && `: ${errors}`}`, facts: measured, session_id };
    }
    const status = (result as { api_error_status?: number | null }).api_error_status;
    return {
      kind: "error",
      reason: "sdk-error",
      message: errors || result.subtype,
      facts: measured,
      session_id,
      ...((transient || (status != null && TRANSIENT_STATUS.has(status))) && { transient: true }),
    };
  }

  /**
   * The session's whole environment: PATH and the locale, the Attempt's caches and temp folder,
   * and for API-key sign-in the key from the keychain. Never the Orchestrator's other variables,
   * so a stray key in your shell can't switch billing. Subscription sign-in keeps your HOME,
   * where its login lives (its commands still can't read it: the Sandbox denies `~/.claude`).
   * Null if API-key sign-in has no key.
   */
  private async env(request: AgentRunRequest): Promise<Record<string, string> | null> {
    const base = this.options.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of INHERITED) if (base[key]) env[key] = base[key]!;
    Object.assign(env, request.workingCopy.env, {
      TERM: "dumb",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    if (this.options.signIn === "subscription") {
      env.HOME = this.userHome;
      return env;
    }
    const key = await this.options.apiKey?.();
    if (!key) return null;
    env.ANTHROPIC_API_KEY = key;
    return env;
  }
}

/** Everything the adapter sets on a session, apart from the abort controller and resume. */
export function sessionOptions(request: AgentRunRequest, ctx: { home: string; userHome: string; pluginDir: string; env: Record<string, string> }): Options {
  const wc = request.workingCopy;
  const profile = request.brief.tools;
  const writes = profile === "write-branch";
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const denial = checkToolCall(input.tool_name, toolInput, { workingCopy: wc.dir, factoryHome: ctx.home, userHome: ctx.userHome });
    if (!denial) return {};
    request.events.guardBlocked(denial);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Guard (${denial.guard}): ${denial.why}` } };
  };
  // Tools named in allowedTools never reach this, so it only ever sees Sandbox asks (ADR 0007).
  const canUseTool: CanUseTool = async (tool) => ({
    behavior: "deny",
    message: tool === "SandboxNetworkAccess" ? "The network is closed except for this Stage's allowlist." : `${tool} isn't allowed in Factory sessions.`,
  });
  return {
    cwd: wc.dir,
    model: request.model,
    maxTurns: request.budget.turns,
    maxBudgetUsd: request.budget.usd,
    env: ctx.env,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    managedSettings: { disableAllHooks: true },
    plugins: [{ type: "local", path: ctx.pluginDir }],
    // The Stage's own instructions, always in force; no Skill listing, so it can't wander into another Stage's.
    systemPrompt: { type: "preset", preset: "claude_code", append: stageInstructions(request.brief.instructions, ctx.pluginDir) },
    skills: [],
    permissionMode: "default",
    allowedTools: TOOLS[profile],
    disallowedTools: DISALLOWED,
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    canUseTool,
    outputFormat: { type: "json_schema", schema: request.resultSchema as Record<string, unknown> },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: writes ? [wc.dir, wc.env.TMPDIR, wc.env.XDG_CACHE_HOME] : [wc.env.TMPDIR],
        denyRead: [ctx.home, ...HOME_CREDENTIALS.map((p) => join(ctx.userHome, p)), `${wc.dir}/**/.env*`],
      },
      // Strict twice over: unknown hosts are blocked, not asked about (ADR 0007). Read-only Stages get none.
      network: { allowedDomains: writes ? request.network : [], strictAllowlist: true },
    },
  };
}

function facts(over: Partial<MeasuredFacts>): MeasuredFacts {
  return { cost_usd: 0, tokens: 0, turns: 0, duration_ms: 0, head: null, files_changed: [], ...over };
}
