# Claude Code headless mode and Agent SDK capabilities

Research for [#4](https://github.com/Anwarkamal143/software-agents/issues/4). Question: what can a program control when it drives Claude Code headless (`claude -p`) or through the Claude Agent SDK (TypeScript), and how does Codex compare? This informs the choice between a Claude Code plugin and a standalone TypeScript orchestrator for the Factory.

Researched 2026-11-05. Versions at the time: Claude Code 2.1.318, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@openai/codex` and `@openai/codex-sdk` 0.166.0 (from `npm view`).

## Sources

- [CC-headless] Run Claude Code programmatically: https://code.claude.com/docs/en/headless
- [CC-cli] CLI reference: https://code.claude.com/docs/en/cli-reference
- [SDK-ts] Agent SDK reference, TypeScript: https://code.claude.com/docs/en/agent-sdk/typescript
- [SDK-overview] https://code.claude.com/docs/en/agent-sdk/overview
- [SDK-sessions] https://code.claude.com/docs/en/agent-sdk/sessions
- [SDK-cost] https://code.claude.com/docs/en/agent-sdk/cost-tracking
- [SDK-loop] https://code.claude.com/docs/en/agent-sdk/agent-loop
- [SDK-perms] https://code.claude.com/docs/en/agent-sdk/permissions
- [SDK-hooks] https://code.claude.com/docs/en/agent-sdk/hooks
- [CC-worktrees] https://code.claude.com/docs/en/worktrees
- [Codex-exec] Codex non-interactive mode: https://developers.openai.com/codex/noninteractive (redirects to learn.chatgpt.com/docs/non-interactive-mode)
- [Codex-sdk-docs] https://developers.openai.com/codex/sdk (redirects to learn.chatgpt.com/docs/codex-sdk)
- [Codex-sdk-readme] https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- [Codex-sdk-types] `package/dist/index.d.ts` in `@openai/codex-sdk@0.166.0` (npm tarball)

## How the two Claude interfaces relate

- `claude -p` *is* the Agent SDK in CLI form. The headless page is titled "Run Claude Code programmatically" and says the SDK "is available as a CLI for scripts and CI/CD, or as Python and TypeScript packages for full programmatic control" [CC-headless].
- The TypeScript package `@anthropic-ai/claude-agent-sdk` bundles a native Claude Code binary as an optional platform dependency; "the SDK version tracks the bundled Claude Code version" (SDK 0.3.N bundles Claude Code 2.1.N) [SDK-ts, Installation]. So the SDK spawns a Claude Code subprocess and talks to it over a control protocol. `spawnClaudeCodeProcess` lets you run that process "in VMs, containers, or remote environments" [SDK-ts, Options].
- Entry point: `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`, where `Query` extends `AsyncGenerator<SDKMessage>` [SDK-ts]. Passing an async iterable is "streaming input mode", which several control methods require (see Cancellation).

## Starting and resuming sessions

| Need | CLI | TS SDK |
| - | - | - |
| Fixed session ID | `--session-id <uuid>` | `sessionId` |
| Resume by ID | `--resume <id>` (also accepts a name or the absolute path to a `.jsonl` transcript) | `resume` |
| Most recent in dir | `--continue` | `continue: true` |
| Branch history | `--fork-session` with resume/continue | `forkSession: true` |
| Resume at a message | n/a | `resumeSessionAt` (message UUID) |
| Don't persist | `--no-session-persistence` | `persistSession: false` |
| External transcript store | n/a | `sessionStore` (mirror to another backend so another host can resume) |

Sources: [CC-cli], [SDK-ts Options], [SDK-sessions].

- Session ID is on every result (`session_id`), so capture it from the `json` / `result` message [CC-headless, SDK-sessions].
- Transcripts live at `~/.claude/projects/<encoded-cwd>/*.jsonl` (or under `$CLAUDE_CONFIG_DIR`) [SDK-sessions]. Resume by ID searches the current project, its git worktrees, then every other project on the machine (v2.1.223+) [CC-cli `--resume`].
- SDK helper functions: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`, `forkSession()` [SDK-ts Functions].
- Gotcha: forking branches the conversation, not the filesystem. File edits from a fork are real [SDK-sessions].
- Gotcha: `--continue` picks "most recent in this directory", which is unsafe with parallel sessions. Use explicit IDs [CC-headless].
- Gotcha: by default a resumed interrupted turn is left as-is; set `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` to continue it [CC-headless].

## Choosing model, tools and configuration per session

- Model: `--model` / `model` (alias such as `sonnet`, `opus`, `haiku`, `fable` or a full ID); `--fallback-model` / `fallbackModel` takes a comma-separated chain; `--effort` / `effort` (`low`..`max`) [CC-cli, SDK-ts]. Mid-session `setModel()` works only in streaming input mode [SDK-ts Query].
- Which tools exist: `--tools` / `tools` restricts the built-in set (`""` disables all). It doesn't affect MCP tools; use `--disallowedTools "mcp__*"` for those [CC-cli].
- `--allowedTools` / `allowedTools` auto-approves; it "does not restrict Claude to only these tools" [SDK-ts]. `--disallowedTools` with a bare name removes the tool; a scoped rule like `Bash(rm *)` denies matching calls "in every permission mode, including bypassPermissions" [SDK-ts, CC-cli].
- System prompt: `--system-prompt` replaces, `--append-system-prompt` appends [CC-cli]. In the SDK, **the default `systemPrompt` is a minimal prompt, not Claude Code's**; pass `{ type: 'preset', preset: 'claude_code', append }` to get Claude Code behaviour [SDK-ts Options].
- Subagents: `--agents` / `agents` (JSON definitions), `--agent` / `agent` to pick the main-thread agent [CC-cli, SDK-ts].
- MCP: `--mcp-config` + `--strict-mcp-config` / `mcpServers` + `strictMcpConfig`; the SDK also supports in-process MCP servers via `createSdkMcpServer()` and `tool()` [CC-cli, SDK-ts].
- Plugins and skills: `--plugin-dir` / `plugins`; `skills` option [CC-cli, SDK-ts]. So a Factory can load a Factory plugin into each headless session.
- Settings: `--settings` (file or inline JSON) and `--setting-sources user,project,local` / `settings`, `settingSources` (`[]` disables filesystem settings; managed policy still loads) [CC-cli, SDK-ts].
- Reproducibility: `--bare` skips auto-discovery of hooks, skills, commands, subagents, plugins, MCP servers, auto memory and CLAUDE.md. It is "the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release" [CC-headless]. Gotchas: bare mode ignores OAuth/keychain (needs `ANTHROPIC_API_KEY` or `apiKeyHelper`), hooks don't run even if passed via `--settings` or a plugin, and background tasks are off [CC-headless].
- Gotcha: without `--bare`, a `-p` session runs the project's `.claude/settings.json` hooks and connects `.mcp.json` servers "even in a folder you've never trusted", with no trust dialog [CC-headless]. Relevant when the Factory checks out arbitrary branches.
- Structured final output: `--json-schema` with `--output-format json` puts the result in `structured_output`; SDK `outputFormat: { type: 'json_schema', schema }`. The field is absent if the run ends without valid output, so check for it [CC-headless, SDK-ts]. Useful for a QA/review Stage returning a verdict.

## Permission modes

- Modes: `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` [CC-cli `--permission-mode`, SDK-ts PermissionMode]. SDK `bypassPermissions` also needs `allowDangerouslySkipPermissions: true` [SDK-ts].
- Since v2.1.302, `-p` runs start in Manual mode when nothing sets a mode; calls needing approval are denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves [CC-headless].
- `dontAsk` denies everything that would prompt (good for locked-down CI). `auto` has a classifier review actions; a bare `Bash` allow entry is dropped in auto mode [CC-headless].
- `--permission-prompts none` / `permissionPrompts: 'none'`: unattended runs; denies anything that would prompt, removes `AskUserQuestion`, cancels unanswered MCP elicitations. Denials appear as `permission_denied` system messages and in `permission_denials` on the result [CC-headless].
- Programmatic approval: SDK `canUseTool(toolName, input, { signal, ... })` callback, or CLI `--permission-prompt-tool mcp__server__tool` [SDK-ts, CC-cli].
- Evaluation order: hooks, deny rules, ask rules, permission mode, allow rules, then `canUseTool`. A hook `allow` doesn't skip deny/ask rules. Gotcha: "Auto-approved tools never reach `canUseTool`", so checks placed there are silently bypassed for tools approved earlier [SDK-perms].
- Runtime change: `setPermissionMode()` (streaming input mode only) [SDK-ts Query].

## Hooks

- Events (TS `HookEvent`): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `MessageDisplay` [SDK-ts].
- SDK hooks are in-process callbacks: `hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [fn] }] }`. Shell-command hooks from settings files also run when the matching `settingSources` are loaded [SDK-hooks]. Callbacks can allow, block, modify input, or inject context [SDK-hooks].
- `includeHookEvents: true` streams `hook_started` / `hook_progress` / `hook_response` messages [SDK-ts].
- A `PreToolUse` hook returning `permissionDecision: "defer"` ends the run with `stop_reason: "tool_deferred"` and `deferred_tool_use`; resume with the same session ID to continue. This is a natural "pause for human gate" primitive [SDK-ts SDKResultMessage].
- CLI-only route: hooks via `--settings` JSON or a plugin's `hooks/hooks.json`, but not in `--bare` mode [CC-headless].

## Cost, tokens and turn counts

- Result message (`--output-format json` or the final `result` event / `SDKResultMessage`): `total_cost_usd`, `usage`, `modelUsage` (per model), `num_turns`, `duration_ms`, `duration_api_ms`, `is_error`, `stop_reason`, `terminal_reason`, `permission_denials`, `session_id`, optional `structured_output` [SDK-ts].
- Result `subtype`: `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries` [SDK-ts].
- Use `modelUsage` for accounting: `usage` covers the main loop only and excludes subagents; `modelUsage` and `total_cost_usd` include subagents and compaction [SDK-ts].
- Gotcha: costs are "client-side estimates, not authoritative billing data", computed from a price table bundled at build time; "Don't bill end users or trigger financial decisions from these fields" [SDK-cost]. Fine for a soft budget Policy, not for billing.
- Gotcha: on resume, `total_cost_usd` includes earlier runs' totals, but `--max-budget-usd` / `maxBudgetUsd` counts only the current call [CC-headless, CC-cli, SDK-ts].
- Gotcha: per-step assistant messages from parallel tool calls share a message ID; dedupe by ID. Per-step `output_tokens` is a placeholder; read output tokens from the result [SDK-cost].
- Limits: `--max-turns` / `maxTurns` (no limit by default) and `--max-budget-usd` / `maxBudgetUsd` (print mode only in CLI). The budget is checked after each response, so "Spend can pass the cap"; leave headroom. At the cap, new subagents fail with `Budget limit reached` [CC-cli, SDK-loop]. Alpha `taskBudget: { total }` tells the model its token budget [SDK-ts].
- Live context breakdown: `getContextUsage()` [SDK-ts Query].

## Streaming structured events

- CLI: `--output-format stream-json --verbose` gives NDJSON; add `--include-partial-messages` for token deltas (`stream_event`). The last line is the `result` message [CC-headless].
- Bidirectional CLI: `--input-format stream-json` accepts user messages on stdin; `--replay-user-messages` echoes them [CC-cli].
- SDK: iterate the `Query` generator; `SDKMessage` is a large union including assistant/user messages, `result`, `system` (`init`, `api_retry`, `permission_denied`, ...), partial messages, hook events, task started/progress/notification, rate-limit events, compact boundaries [SDK-ts].
- `system/init` reports model, tools, MCP servers (`mcp_servers`, `mcp_server_errors`), plugins (`plugins`, `plugin_errors`) and a `capabilities` array for feature detection. Gotcha: invalid `--mcp-config` entries are skipped silently when stderr is captured; check `mcp_server_errors` [CC-headless].
- Subagent messages carry `parent_tool_use_id`; `--forward-subagent-text` / `forwardSubagentText` adds their text and thinking blocks [CC-headless, SDK-ts].

## Timeouts and cancellation

- No wall-clock timeout flag. Bound runs with `maxTurns`, `maxBudgetUsd`, and your own timer.
- SDK: `abortController` option; `interrupt()` (streaming input mode only) ends the current turn cleanly; `close()` force-terminates the process; `stopTask(taskId)` stops a background task [SDK-ts].
- CLI: SIGINT ends the turn; SIGTERM exits 143, kills running Bash process trees, runs `SessionEnd` hooks, and records no result for the in-progress turn. Prefer SIGINT or `interrupt()` before killing [CC-headless].
- API-level env vars (pass via `env`): `API_TIMEOUT_MS` (default 600000, per attempt, headers only), `CLAUDE_CODE_MAX_RETRIES` (default 10, cap 15), `CLAUDE_CODE_RETRY_WATCHDOG=1` for long outages, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (default and minimum 300000), `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` for subagents [SDK-ts "Handle slow or stalled API responses"]. Retries surface as `system/api_retry` events [CC-headless].
- Gotcha: SDK `env` *replaces* the subprocess environment; spread `process.env` to keep `PATH` [SDK-ts].
- Gotcha: after the final turn a `-p` run can stay alive waiting for background work (subagents, background commands, Monitor watches), capped at 10 minutes idle by default (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) [CC-headless].
- Exit codes: 0 on success, non-zero on failure; in-run failures (such as missing auth) print as the result on stdout [CC-headless].

## Running in a git worktree

- Easiest for the Factory: create the worktree yourself (`git worktree add`) and set `cwd` (SDK) or run `claude -p` from that directory. Session transcripts are keyed by cwd [SDK-sessions].
- `projectConfigRoot` (SDK, v2.1.275+): "Absolute path of the trusted checkout that `cwd` is a worktree of." Project settings, `.mcp.json`, and `.claude/` commands, agents, skills load from there; `CLAUDE.md` still loads from `cwd` [SDK-ts].
- Built-in: `--worktree <name>` / `-w` creates `<repo>/.claude/worktrees/<name>`; `#<number>` or a PR URL branches from that PR [CC-cli]. `-p` runs skip the trust check, but "Claude doesn't clean up their worktrees" and leaves a lock until a later stale-lock sweep; remove with `git worktree unlock` + `git worktree remove` [CC-worktrees].
- Resuming a session that ended inside a worktree returns it there (also for `-p` resume, v2.1.212+) [CC-worktrees].
- If the cwd is deleted mid-run the session keeps going but shell commands fail [CC-headless].

## Authentication and terms gotcha

- "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods" [SDK-overview]. A Factory distributed to others should use API keys (or Bedrock/Vertex/Foundry). A personal local Factory reusing the user's own `claude` login is a grey area; `--bare` forbids it anyway (API key or `apiKeyHelper` only) [CC-headless].

## Codex and other agents, comparably

| Concern | Claude Code | Codex |
| - | - | - |
| Headless CLI | `claude -p` | `codex exec` [Codex-exec] |
| TS SDK | `@anthropic-ai/claude-agent-sdk`, spawns bundled CC binary | `@openai/codex-sdk`, "spawns the CLI and exchanges JSONL events over stdin/stdout" [Codex-sdk-readme] |
| Events | `stream-json` / `SDKMessage` | `--json` JSONL: `thread.started` (`thread_id`), `turn.started`, `turn.completed`, `turn.failed`, `item.started/updated/completed`, `error`; items include agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, todo/plan [Codex-exec, Codex-sdk-types] |
| Resume | `--resume <id>` / `resume` | `codex exec resume <id>` or `--last`; SDK `resumeThread(id)`; threads in `~/.codex/sessions` [Codex-exec, Codex-sdk-readme] |
| Model / effort | `model`, `effort` | `ThreadOptions.model`, `modelReasoningEffort` [Codex-sdk-types] |
| Permissions | 6 permission modes, rules, hooks, `canUseTool` | `sandboxMode`: `read-only` (default) / `workspace-write` / `danger-full-access`; `approvalPolicy`: `never` / `on-request` / `on-failure` / `untrusted`; `networkAccessEnabled`. `--full-auto` removed [Codex-exec, Codex-sdk-types] |
| Approval callback / hooks | `canUseTool`, in-process hooks | None in the TS SDK types; the docs point custom clients needing approvals and streamed events to the Codex **app server** (JSON-RPC) [Codex-sdk-docs] |
| Tokens | `usage`, `modelUsage` | `turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` [Codex-exec, Codex-sdk-types] |
| Cost | `total_cost_usd` estimate | **No cost field**; compute from tokens x price table [Codex-exec] |
| Budget / turn caps | `maxBudgetUsd`, `maxTurns` | None found in exec docs or SDK types |
| Structured output | `--json-schema` / `outputFormat` | `--output-schema <file>` / `run(..., { outputSchema })` [Codex-exec, Codex-sdk-readme] |
| Cancellation | `abortController`, `interrupt()`, `close()` | `TurnOptions.signal: AbortSignal` [Codex-sdk-types] |
| Working dir | `cwd`, `--worktree` | `workingDirectory`; **must be a git repo** unless `skipGitRepoCheck` [Codex-sdk-readme] |
| Auth | API key (required for third-party products) | Saved CLI auth or `CODEX_API_KEY` [Codex-exec] |

- Codex gotchas: read-only by default; progress on stderr and only the final message on stdout without `--json`; a `required = true` MCP server failing to init exits with an error; `codex mcp-server` has been removed [Codex-exec, Codex-sdk-docs]. Codex SDK `env` also fully replaces the inherited environment [Codex-sdk-readme].
- Implication: a common `AgentRunner` adapter is feasible (start/resume, model, cwd, schema output, abort signal, token usage). Claude-only features (hooks, per-call approval callback, built-in USD budget and turn caps, cost estimate) must be emulated or treated as optional capabilities for Codex.

## Implications for plugin vs standalone orchestrator

- Everything listed above is driven from *outside* a session: per-Stage model, tools, permission mode, budget, worktree cwd, hooks, schema output, cancellation, cost capture. A standalone TypeScript orchestrator using the Agent SDK gets all of it, and can wrap Codex behind the same interface.
- A plugin contributes components *into* a session (commands, agents, skills, hooks, MCP servers, monitors per [CC-plugins-reference](https://code.claude.com/docs/en/plugins-reference)), and headless sessions can load one with `--plugin-dir` / `plugins`. That suggests a hybrid: the orchestrator owns Stages and Policies; an optional plugin carries per-Stage skills and hooks. Note that hooks in a plugin don't run under `--bare`.
