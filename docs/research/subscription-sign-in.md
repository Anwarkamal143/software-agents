# Subscription sign-in for Factory agent sessions

Research for [#12](https://github.com/Anwarkamal143/software-agents/issues/12). The Factory (a standalone TypeScript Orchestrator that runs one Claude Code session per Stage through the Claude Agent SDK, see #5) has to support two sign-in modes: an API key and the user's Claude subscription login. Questions: (1) what Anthropic's terms allow for unattended use of a subscription, for a solo user and for a distributed Factory; (2) how the SDK picks up subscription credentials, and how a session that can't use `--bare` can still be kept away from a Target repo's hooks, settings and `.mcp.json`; (3) how cost reporting, budget caps and rate limits differ between the modes.

Researched 2026-11-05. Versions: `@anthropic-ai/claude-agent-sdk` 0.3.318, which bundles Claude Code 2.1.318 (`package.json` `claudeCodeVersion`). This builds on [docs/research/claude-headless-sdk.md](https://github.com/Anwarkamal143/software-agents/blob/research/claude-headless-sdk/docs/research/claude-headless-sdk.md) (branch `research/claude-headless-sdk`) and doesn't repeat it.

Lines marked **Inference** are my reading. Everything else is a quote or a close paraphrase of the cited source. Policy pages change often. Each quote carries the date I read it (2026-11-05) and the page's own date where it has one.

## Sources

- [Legal] Claude Code docs, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance (no page date; read 2026-11-05)
- [SDK-overview] Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview (read 2026-11-05)
- [Consumer] Anthropic Consumer Terms of Service: https://www.anthropic.com/legal/consumer-terms (effective Oct 8, 2025; read 2026-11-05)
- [Commercial] Anthropic Commercial Terms of Service: https://www.anthropic.com/legal/commercial-terms (cited by [SDK-overview] and [Legal]; not quoted here)
- [Auth] Claude Code docs, Authentication: https://code.claude.com/docs/en/authentication
- [Headless] Run Claude Code programmatically: https://code.claude.com/docs/en/headless
- [Features] Agent SDK, Use Claude Code features in the SDK: https://code.claude.com/docs/en/agent-sdk/claude-code-features
- [Perms] Configure permissions, "What runs before you trust a folder": https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder
- [CLI] CLI reference: https://code.claude.com/docs/en/cli-reference
- [Cost] Agent SDK, Track cost and usage: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- [Costs] Claude Code docs, Manage costs effectively: https://code.claude.com/docs/en/costs
- [Errors] Claude Code docs, Errors: https://code.claude.com/docs/en/errors
- [Interactive] Interactive mode, "Wait for a usage limit to reset": https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset
- [SDK-plan] Help Center, "Use the Claude Agent SDK with your Claude plan": https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (updates dated June 15, 2026 and October 7, 2026; read 2026-11-05)
- [Credits] Help Center, "Monthly API credits for Max, Ultra, and Team plans": https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans ("Updated this week" as of 2026-11-05)
- [CC-plan] Help Center, "Use Claude Code with your Pro, Max, or Ultra plan": https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan ("Updated this week" as of 2026-11-05)
- [Types] `sdk.d.ts` in the `@anthropic-ai/claude-agent-sdk@0.3.318` npm tarball

## 1. What the terms allow

### What the sources say (quoted 2026-11-05)

Which terms apply [Legal]:

> Your use of Claude Code is subject to: Commercial Terms of Service - for Team, Enterprise, and Claude API users; Consumer Terms of Service - for Free, Pro, Max, and Ultra users

> Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users [...] [SDK-overview, "License and terms"]

Consumer Terms (effective Oct 8, 2025), the default rule on automation and sharing [Consumer]:

> You may not access or use, or help another person to access or use, our Services in the following ways: [...] Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

Anthropic's statements that subscription use from scripts and the SDK is expected:

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK. [Legal, "Acceptable use"]

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token` [...] This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan. [Auth, "Generate a long-lived token"]

> Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits. [SDK-plan]

> Update October 7, 2026: [...] Nothing changes for your plan: when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits. [SDK-plan]

The rule on OAuth vs API keys [Legal, "Authentication and credential use"]:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> [...] Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

On products that run Claude Code [Legal, "Can customers offer Claude Code in their products?"]:

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> - **The Claude Code binary must not be modified.** [...] customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> - **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential [...]. That usage is billed directly to the end user under their own agreement with Anthropic [...].

And the SDK-specific note [SDK-overview]:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

### Inference: solo user on their own subscription

- On its own, the Consumer Terms automation clause would forbid scripted subscription use. But it has a carve-out ("or where we otherwise explicitly permit it"), and Anthropic's own docs explicitly provide and describe subscription auth for scripts and the SDK: `claude setup-token` "for CI pipelines, scripts", the "Agent SDK, `claude -p` [...] still draw from your subscription limits" notes, and "ordinary, individual usage of Claude Code and the Agent SDK". So a solo user running the Factory on their own machine, signed in to their own plan, looks permitted.
- The limit is "ordinary, individual usage". No source defines it in numbers. A Factory that fans out many parallel Stages around the clock is the kind of use that could be judged outside it, and Anthropic says it may enforce "without prior notice". Rate-limiting and serialising Stages in subscription mode lowers that risk.
- Sharing is out: one subscription must not drive Jobs for other people (no "make your Account available to anyone else").

### Inference: a Factory distributed to other people

- The sources pull in two directions. [Legal] allows a product that runs the **unmodified Claude Code binary**, where each end user signs in with their own subscription through Anthropic's flow. [SDK-overview] says third-party developers may not "offer claude.ai login" for "agents built on the Claude Agent SDK" unless approved, and [Legal] says the same about offering Claude.ai login "into their own applications". The Factory is both an SDK agent and something that runs the Claude Code binary (the SDK spawns the bundled binary), so it's unclear which rule wins.
- The safe reading for distribution:
  - Default to API key mode (or Bedrock / Vertex / Foundry), with the user's own key. That's the documented path for SDK-built products.
  - In subscription mode, the Factory must never run a login flow, show a "Sign in with Claude" button, ask for or store `CLAUDE_CODE_OAUTH_TOKEN`, or read the keychain or `.credentials.json` itself. The user signs in with Claude Code's own `claude auth login` / `/login`, and the Factory only starts sessions that inherit that existing login. The Factory's docs should frame this as the user's own Claude Code install, not as a Factory sign-in feature.
  - Don't host Jobs for other people on one subscription. Each person runs their own Factory with their own credentials.
  - If subscription mode is to be a headline feature of a distributed product, ask Anthropic for the "previously approved" status ([contact sales](https://www.anthropic.com/contact-sales)) rather than relying on the [Legal] carve-out.
- Branding: a distributed Factory can't be called "Claude Code" anything. "Powered by Claude" is fine [SDK-overview, "Branding guidelines"].

## 2. How credentials are picked up, and isolation without `--bare`

### Credential resolution (sources)

- The SDK runs the bundled Claude Code binary, so it uses Claude Code's credential order: `apiKeyHelper`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` "apply to the CLI and the surfaces that wrap it, including [...] the Agent SDK" [Auth].
- Precedence [Auth, "Authentication precedence"]: (1) cloud provider env (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`); (2) `ANTHROPIC_AUTH_TOKEN`; (3) `ANTHROPIC_API_KEY`, which "In non-interactive mode (`-p`), the key is always used when present"; (4) `apiKeyHelper`; (5) `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`); (6) Anthropic profile / federation credentials; (7) "Subscription OAuth credentials from `/login`".
- Storage [Auth, "Credential management"]: macOS Keychain (falling back to `~/.claude/.credentials.json`, mode 0600, when the Keychain rejects the write); Linux and Windows use `.credentials.json`. With `CLAUDE_CONFIG_DIR` set, Claude Code "keeps the `.credentials.json` file under that directory [...] and keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry."
- `claude setup-token` prints a one-year token and "does not save the token anywhere". It "can only make model requests" (no Remote Control, no claude.ai connectors) [Auth].
- Expiry: once a `/login` credential can't be refreshed, "each model request fails with `Login expired · Please run /login`"; "Renewing early matters most for sessions that run unattended" [Auth].
- Bare mode: "In bare mode, Claude Code never reads OAuth credentials or the system keychain" [Headless], and it "does not read `CLAUDE_CODE_OAUTH_TOKEN`" [Auth]. So subscription mode can't use `--bare`.
- Detecting the active credential: `system/init` carries `apiKeySource` (`'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'`, where `'none'` means e.g. "claude.ai OAuth login"), and `query.accountInfo()` returns `email`, `organization`, `subscriptionType`, `tokenSource`, `apiKeySource` and `apiProvider` [Types].

### Inference: what the Factory should do per mode

- **API key mode**: pass `ANTHROPIC_API_KEY` in `env` and use `--bare` / the equivalent options. This is the documented scripted path.
- **Subscription mode**: build `env` from `process.env` but delete `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_*` and `ANTHROPIC_PROFILE`, so a stray key in the user's shell doesn't silently switch billing (in `-p` an env key "is always used when present"). Leave `CLAUDE_CONFIG_DIR` alone, or the session reads a different Keychain entry and has no login. At session start, assert `apiKeySource === 'none'` and that `accountInfo().subscriptionType` is set, and fail the Stage if not.
- A repo's project settings can supply `apiKeyHelper` and an `env` block, and under `-p` those are "Used" even in an untrusted folder [Perms table]. So a Target repo could swap the credential unless project settings are excluded (next section). That's another reason to exclude them.
- Treat `Login expired` / `authentication_failed` (an `SDKAssistantMessageError` and `api_retry` error category [Types, Headless]) as "pause the Job and ask the human to sign in again", not as a Stage failure to retry.

### Isolation from a Target repo without `--bare` (sources)

What a `-p` / SDK run uses from a never-trusted folder [Perms, "What runs before you trust a folder"]:
- Hooks in settings files, the `env` block and helper commands such as `apiKeyHelper`, and a project skill's hooks and `allowed-tools`: **Used**.
- `permissions.allow` rules and `additionalDirectories` in `.claude/settings.json`: **Not used**.
- Servers in `.mcp.json`: "Connected without asking, approved or not. The SDK loads them only when `settingSources` includes project settings."

Anthropic's own advice for `claude -p` "in a repository you didn't write" [Perms]:
> - Pass `--setting-sources user`, or set the SDK's `settingSources` without project settings, so Claude Code reads neither the project's settings files nor its `.mcp.json`
> - Start with `--bare` [...]
> - Pass `--settings '{"disableAllHooks": true}'` to turn hooks off for that run. Setting it in your user settings alone isn't enough, because the repository's project settings take precedence over yours and can set it back to `false`
> - Add a `disabledMcpjsonServers` entry to reject a `.mcp.json` server by name in every session type

SDK options that do the work:
- `settingSources` [Features, Types]: `"project"` = `<cwd>/.claude/settings.json` and hooks, project CLAUDE.md and `.claude/rules`, and project skills, commands and subagents. `"local"` = `CLAUDE.local.md` and `.claude/settings.local.json`. `"user"` = `~/.claude/`. Omitted means `["user","project","local"]`. `[]` disables all three. "Must include `'project'` to load CLAUDE.md files."
- Still read regardless of `settingSources` [Features]: managed policy settings, `~/.claude.json`, auto memory (disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), and claude.ai MCP connectors when signed in with a claude.ai login ("Passing `mcpServers: {}` does not suppress the connectors". Use `strictMcpConfig: true`, `disableClaudeAiConnectors`, or `ENABLE_CLAUDEAI_MCP_SERVERS=false`).
- `strictMcpConfig: true`: "Only use MCP servers passed via the `mcpServers` option [...] ignoring all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter — including subagent frontmatter MCP" [Types].
- `managedSettings` (SDK option): "Policy-tier settings supplied by the spawning parent process". With no admin tier on the machine, "these apply as the sole policy tier (still filtered restrictive-only)". "`disableAllHooks: true` binds as `allowManagedHooksOnly: true`" [Types]. `allowManagedHooksOnly`: "User, project, and local hooks and the hooks of plugins the user installed are ignored" [Types].
- `projectConfigRoot`: "The trusted checkout `cwd` is a worktree of. Project settings (hooks, permissions), `.mcp.json`, the `.claude` config trees [...] come from here instead of `cwd`, so whatever the branch checked out in `cwd` carries is not what the session runs." [Types]
- `--safe-mode` (CLI): disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents, and auto memory, while "Authentication, model selection, built-in tools, and permissions work normally, which differs from `--bare`" [CLI].

### Inference: a subscription-mode isolation recipe

```ts
query({ prompt, options: {
  cwd: worktreePath,
  settingSources: [],               // no project/local/user settings, hooks, .mcp.json, skills, CLAUDE.md
  strictMcpConfig: true,            // only Factory-supplied MCP; also blocks claude.ai connectors
  mcpServers: factoryMcpServers,
  managedSettings: { disableAllHooks: true },     // project can't re-enable filesystem hooks
  hooks: factoryHookCallbacks,      // in-process callbacks are not settings-file hooks
  plugins: [factoryPlugin],         // load Stage skills explicitly
  systemPrompt: { type: 'preset', preset: 'claude_code', append: stageInstructions + targetClaudeMd },
  env: { ...envWithoutApiKeys, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
}})
```

- `settingSources: []` also drops the Target repo's `CLAUDE.md`. If the Stage should follow the repo's conventions, the Orchestrator can read `CLAUDE.md` / `AGENTS.md` itself and append it to the system prompt as text. Text can't run code; hooks and MCP servers can.
- `projectConfigRoot` isn't an isolation tool against a hostile Target repo. It loads the trusted checkout's config instead of the branch's. That helps when an agent-written branch could plant hooks, but it still runs the default branch's hooks. Whether it accepts an arbitrary empty directory isn't documented. Test before relying on it.
- Unverified, test before relying on them: (a) whether `managedSettings: { disableAllHooks: true }` also blocks hooks from a plugin passed through `plugins` (the `allowManagedHooksOnly` text suggests yes, unless "managed settings enable" that plugin); (b) whether SDK callback `hooks` keep firing under it (the docs say hooks "defined in settings files and by installed plugins" are disabled, which reads as callbacks being unaffected); (c) whether `--safe-mode` combines with `-p` and with `--plugin-dir`.
- The managed policy tier and server-managed settings on the user's machine still apply. The Factory can't and shouldn't override them.

## 3. Cost, budgets and limits by mode

| Concern | API key mode | Subscription mode |
| - | - | - |
| What you pay | Per token at API rates, billed to the Console org [Costs] | Included in the plan until a limit is hit. Optional usage credits after that [CC-plan, Costs] |
| `total_cost_usd` / `modelUsage` | Client-side list-price estimate: "Don't bill end users or trigger financial decisions from these fields" [Cost] | Same estimate is emitted. For subscribers "the session cost figure isn't relevant for billing purposes" [Costs, `/usage` note] |
| `maxBudgetUsd` | Checked against that estimate; "Spend can pass the cap" [CLI] | Same mechanism. **Inference**: still useful as a per-Stage size cap (a proxy for how much of the plan window it uses), not as money |
| Authoritative spend cap | Console workspace spend limits; Console Cost page [Costs] | Plan windows are the ceiling. Usage-credit monthly spend limit on claude.ai [Costs] |
| Throughput limits | Org TPM/RPM rate limits; a Claude Code workspace rate limit can cap its share [Costs] | Rolling five-hour window plus weekly window (Ultra: weekly only); Max/Ultra have a separate weekly Fable limit [CC-plan]. "These limits are shared across Claude and Claude Code" [CC-plan] |
| Hitting the limit | `429` throttles, auto-retried; `CLAUDE_CODE_RETRY_WATCHDOG=1` retries indefinitely in unattended runs [Errors] | "Claude Code blocks further requests until the reset time shown" [Errors]. Auto-continue after reset "is on by default in interactive sessions" only [Interactive] |
| Live limit telemetry | `rate_limits_available: false`, `rate_limits: null` [Types] | `rate_limit_event` messages with `status` (`allowed` / `allowed_warning` / `rejected`), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`, ...), `utilization` and `resetsAt`; plus the experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` with `five_hour` / `seven_day` / `seven_day_oauth_apps` / per-model windows [Types] |
| Prompt-cache TTL default | 5 minutes [Cost] | 1 hour "on a Claude subscription within its usage limits", dropping to 5 minutes on usage credits [Cost, Types] |
| Org reporting | Console dashboard, Claude Code Analytics API [Costs] | Team/Enterprise: org analytics spend report. Individual plans: `/usage` only [Costs] |

Notes:
- Max, Ultra and Team plans now include monthly API credits ($100 Max, $200 Ultra, $20 / $100 per Team seat pooled up to $500). They "cover `claude -p` and the Claude Agent SDK when you run them yourself with an API key from your linked Claude Console organization". When "signed in with your Claude plan instead, `claude -p` and Agent SDK usage still draw from your plan's usage limits and don't use your API credits" [Credits]. They expire each cycle, and with no other credits "API requests stop until your next monthly credits arrive" [Credits]. **Inference**: for Max/Ultra users this gives a terms-clean API key mode at no extra cost up to the credit, which weakens the case for building subscription mode into a distributed Factory.
- The "previously-announced changes to Claude Agent SDK usage" are paused [SDK-plan]. [Credits] separately says of "the Agent SDK credits announced in June": "That credit isn't available." **Inference**: those were probably the same change, and subscription treatment of SDK usage is in flux. Keep the sign-in mode behind the `AgentRunner` seam and re-check [SDK-plan] before each release.

### Inference: Orchestrator behaviour in subscription mode

- Subscribe to `rate_limit_event`. On `allowed_warning`, stop launching new Stages. On `rejected`, park the Job until `resetsAt`, then resume the session by ID (an interrupted turn is left as-is unless `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, per the prior research). Headless runs don't auto-continue the way interactive sessions do.
- Keep Stage concurrency low (one or two) by default. Parallel sessions drain the same five-hour and weekly windows the user's own chat and Claude Code use, and heavy fan-out makes "ordinary, individual usage" harder to claim.
- Record `total_cost_usd` in both modes but label it "estimated API-equivalent cost" in subscription mode. Budget Policies should be expressed per Stage in that estimate, or in tokens, so they work the same in both modes.

## Open questions

- Whether a distributed Factory that only inherits an existing Claude Code login (and never runs one) counts as "offering claude.ai login" under [SDK-overview]. Only Anthropic can answer this.
- Exact numeric limits for each plan's five-hour and weekly windows aren't published in the sources read.
- The three unverified isolation behaviours listed in section 2 need a quick prototype against a repo with a planted hook and `.mcp.json`.
