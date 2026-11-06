# PROTOTYPE: SDK isolation and sandbox verification (throwaway, never merged)

Answers [SDK isolation and sandbox verification](https://github.com/Anwarkamal143/software-agents/issues/14) for ADR 0007.
Run on macOS (Seatbelt), Claude Code 2.1.319, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@anthropic-ai/sandbox-runtime` 0.0.81, signed in with a subscription, 2026-11-06.

```bash
npm i
export WORK=/tmp/factory-sdk-spike
bash setup-fixture.sh      # hostile Target repo + Factory plugin, each leaves marker files
node spike.mjs [case]      # control | isolated | isolated-no-managed | isolated-strict-net | isolated-deny-ask
node check-stage.mjs       # hostile verify command under sandbox-runtime
```

The fixture plants a SessionStart and PreToolUse hook, an `apiKeyHelper` returning a fake key, a settings `env` block, a `.mcp.json` server, canary `CLAUDE.md` / `AGENTS.md` and a `.env`.

## Findings

| Check | Result |
|---|---|
| Control (SDK defaults) | Repo `apiKeyHelper`, SessionStart hook and MCP server all ran; the session hung (240s timeout). The fixture is a real threat. |
| Isolated (`settingSources: []`, `strictMcpConfig`, `managedSettings.disableAllHooks`, stripped env) | No repo hook, helper, MCP, `env` or CLAUDE.md/AGENTS.md; `apiKeySource: none`. ~$0.003–0.005 per run on Haiku. |
| 1. `disableAllHooks` vs Factory plugin hooks | **Blocked.** The plugin hook fires only without `disableAllHooks`. |
| 2. In-process callback hooks (Guards) | **Fire** under `disableAllHooks` for every tool call; a `deny` on Read `.env` worked. |
| 2b. `canUseTool` | **Not called** for tools listed by bare name in `allowedTools` (SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). It is called for `SandboxNetworkAccess`. |
| 3. `--safe-mode` with `-p` | Runs, skips hooks and MCP, but **still runs the repo's `apiKeyHelper`** (which hung the session) and **still applies its `env` block**. Not a defence. |
| 4. SDK sandbox, filesystem | `denyRead` (`.env`) and writes outside `allowWrite` blocked; writes inside the worktree work. |
| 4b. SDK sandbox, network | `allowedDomains: []` alone **does not block**: unknown hosts become a `SandboxNetworkAccess` ask to `canUseTool`, and an allow-all callback let `example.com` through (200). `strictAllowlist: true`, or denying that ask, blocks it (403 from the proxy). |
| 4c. Fail closed | Not exercised (Seatbelt is always present on macOS). SDK docs: with `enabled: true`, `failIfUnavailable` defaults to true and `query()` ends with an error result. |
| 5. `sandbox-runtime` for Check Stages | Works: `.env` and `~/.ssh` unreadable, outside writes blocked, only the passed secret visible, allowlisted registry 200, other host 403 with a violation report. **Must spawn asynchronously**: the network proxy runs in the Orchestrator's process, and `spawnSync` blocks it (every request then times out). |
