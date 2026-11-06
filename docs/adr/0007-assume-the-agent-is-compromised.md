# Assume the agent is compromised: bound its capabilities, don't detect injection

Every Stage run reads text that someone other than you may have written, so the Factory treats every agent session as potentially hijacked by prompt injection and limits what a hijacked session could do, rather than trying to spot injected text. We rejected a v1 injection classifier or scanning Stage: detection is probabilistic and an attacker gets unlimited tries, while capability limits hold however the agent is talked into misbehaving. The limits are non-negotiable in v1:

- **Job approval.** A Job starts only when a person on `humans` applies the ready label (checked in the issue timeline); the issue's author is irrelevant. Editing the issue title or body afterwards pauses the Job for re-approval, unless the editor is on `humans`, whose edit counts as re-approval (amended by Source trigger mechanics, #17). Stage briefs include the approved body and comments from `humans` only.
- **No credentials in agent sessions.** Agents commit locally in the Job's worktree and never hold a GitHub token. The Orchestrator runs Pre-push checks (only the Job branch moved, no symlinks out of the worktree or submodule changes, a secret scan of the diff, the diff fits the Tool profile) and pushes itself. The Factory acts on GitHub as a GitHub App scoped per Target repo; a personal token is a fallback.
- **Secrets stay out.** Agent sessions get an allowlisted, minimal environment; `.env*`, home-directory credential folders and the Factory home are unreadable. Secrets a check needs go only to that Check Stage's command. Factory credentials live in the OS keychain (or a mode-600 file in the Factory home), never in `factory.yaml`.
- **Sandbox.** Agent Bash and Check Stage commands run under an OS-level Sandbox: writes only to the worktree and a temp folder, network off except the model API unless the Stage's Tool profile enables a per-repo domain allowlist. If the Sandbox can't start, the run fails; it never runs unsandboxed. Read-only Stages (triage, review), which see the rawest text, get no network.
- **Deny-by-default tools.** Explicit `allowedTools` per Tool profile plus a `canUseTool` callback; never `bypassPermissions`; no MCP servers, WebFetch or WebSearch unless configured.
- **Agent output is data.** Verdicts only route and only Evidence satisfies the Merge gate (ADR 0003). Agent-written text the Orchestrator posts is cleaned of @mentions, Reply commands and Factory markers and capped in length.
- **Denials are signals.** Every Guard denial is an Event log entry; three in one Stage run end it with a Human request.

## Consequences

- Reply commands (ADR 0006) also need the sender to still have write access, and count only in comments created after the Human request they answer.
- Check Stages are not trusted just because no agent runs them: they execute code an agent wrote, so they share the Sandbox.
- Verified by prototype (SDK isolation and sandbox verification, #14), which fixes how the Agent adapter applies these limits:
  - Network is closed twice: `strictAllowlist: true` always, and `canUseTool` denies every `SandboxNetworkAccess` ask. An empty `allowedDomains` alone turns unknown hosts into asks, not blocks.
  - Guards are `PreToolUse` callbacks only. `canUseTool` is skipped for tools named in `allowedTools`, so it handles sandbox asks and nothing else.
  - The Factory plugin carries no hooks: `managedSettings.disableAllHooks` blocks them along with the Target repo's, while callback Guards still fire.
  - The adapter never uses `claude -p` or `--safe-mode`, which still run a Target repo's `apiKeyHelper` and apply its `env` block.
  - Check Stages use `sandbox-runtime` spawned asynchronously (its network proxy runs in the Orchestrator's process).
  - The Orchestrator refuses to start Stage runs unless both sandboxes report available, so fail-closed is a self-check, not only an SDK default.
- Containers per Stage run are deferred to the cloud-executor seam.
