# Standalone Orchestrator with a Factory plugin, not a Claude Code plugin

The Factory is a standalone TypeScript **Orchestrator** that owns Job state, Stage order, Policies and every git/GitHub write (PRs, merges, reverts, labels). It runs each Stage as an agent session through an **Agent adapter** (v1: Claude Agent SDK only, signed in with either an API key or the user's Claude subscription, chosen in config) and loads a **Factory plugin** into that session. The plugin carries Stage instructions only, never control logic. We rejected a pure Claude Code plugin in the style of super-board because Policies enforced by a prompt are only suggestions, and because the SDK exposes every per-Stage setting (model, tools, permissions, hooks, budgets, cost, events, cancellation) to an outside process.

## Consequences

- Guards (secret files, paths outside the working copy, destructive commands) are hook callbacks in the Orchestrator, passed in through the SDK. A Target repo's own hooks and `.mcp.json` servers are never loaded into Factory sessions, because Jobs check out untrusted branches.
- Agents may only commit to their Job's branch in their own worktree. They never merge, and never push: the Orchestrator pushes their commits after Pre-push checks (amended by ADR 0007, which keeps every credential out of agent sessions).
- Runs are bounded by the Orchestrator's own timer as well as the SDK's turn and dollar limits, because the SDK has no wall-clock timeout and its cost figures are estimates.
- v1 is a foreground `factory` command (`run`, `status`, `stop`, `retry`), and it is the only writer of Job state. Running it as a background service comes later.
- "Every git/GitHub write" is the Orchestrator's, but not every one is made inline. A write a decision waits on (pushing, opening, merging or reverting a PR) the Orchestrator makes itself. A write that only shows a decision already recorded (status labels and comments, closing or drafting a PR when a Job ends, removing the ready label, reopening a reverted issue) goes through the GitHub Mirror's outbox, so GitHub being down delays it rather than losing it (amended while implementing PRs and merging, #33).
- Subscription sign-in can't use `--bare`, so it needs another way to keep a Target repo's hooks and MCP config out. Researched in Subscription sign-in for Factory agent sessions (#12).
