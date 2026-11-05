# Gap analysis: super-board and marshal-factory

Research for [#3](https://github.com/Anwarkamal143/software-agents/issues/3), part of the planning map [#2](https://github.com/Anwarkamal143/software-agents/issues/2).

**Question.** What does each reference project do well, what does each lack, and which ideas should a v1 Factory borrow or improve on?

**Sources.** Both repos were read at a pinned commit (source and docs only; nothing was executed):

- super-board (SB): [`EricTechPro/super-board@d0b7d5a`](https://github.com/EricTechPro/super-board/tree/d0b7d5a6850614ca809477c1af43d5d7da408726), v3.3.0, MIT.
- marshal-factory (MF): [`ski043/marshal-factory@999ad20`](https://github.com/ski043/marshal-factory/tree/999ad209598517a4c826073b5a0edc2a4097a4fa).

Links below use short paths; prefix `SB:` or `MF:` resolves against those commits. Vocabulary follows `GLOSSARY.md`: **Factory**, **Job**, **Source**, **Stage**, **Policy**, **Target repo**. SB calls a Stage a "lane" and a Job a "card"; MF calls a Job a "job" and its Stages "stages".

## One-paragraph shape of each

**super-board** is a pack of Claude Code skills, Python/bash scripts, guard hooks and one dynamic workflow, installed *into* the Target repo. The interactive Claude session is an orchestrator that plans "waves" and dispatches lane agents per Job: Build, QA, Review, then a scripted merge gate. All state lives on a GitHub Projects v2 board (seven fixed columns) plus structured issue/PR comments; there is no database and no daemon. (SB: `README.md`, `docs/super-board/README.md`, `skills/super-board/SKILL.md`.)

**marshal-factory** is a hosted system: a Bun daemon ("runner") on the owner's Mac under launchd, a Neon Postgres + ingest Function, a Next.js panel on Vercel, optional Modal sandboxes and Slack. Linear is the Source. One agent thread per Job (Claude Code or Codex via T3 Code) follows a single playbook end to end and reports its Stage through an MCP tool and hooks; the runner owns every git/GitHub write and every merge. (MF: `README.md`, `docs/operations.md` "Parts", `playbooks/factory.md`.)

## Comparison by topic

### 1. Pipeline Stages

| | super-board | marshal-factory |
|---|---|---|
| Stages | Fixed: Backlog, Ready, Building, QA, Review, Blocked, Done. Labels route: `qa` skips Building. Not configurable ("Fixed, not configurable"). SB: `skills/super-board/references/config-schema.json` (`columns`, `labels`). | Fixed: queued, triage, investigating, implementing, verifying, pr, plus waiting, failed, merged. MF: `lib/stages.ts`. |
| Who runs a Stage | A separate agent per Stage, each with its own skill (`super-build`, `super-qa`, `super-review`) and model picked by a Haiku router grading complexity. SB: `workflows/super-board-wave.js`, README "Models". | One agent thread does every Stage; Stages are self-reported milestones (`report_stage`) inside one session. MF: `playbooks/factory.md` "Standing rules". |
| Transitions | Implicit in skill prose and column moves; bounce back to Ready on QA/Review fail, `rebuild_cap` + `root-cause-hash` stops loops. SB: `skills/super-board/references/run.md` lines ~654, ~730. | An explicit transition table keyed by *cause* (`report`, `watchdog`, `conflict`, `changes`, `merged`, ...); ingest refuses illegal moves and records why. Idempotent by event id; stale and earlier-attempt events are skipped. MF: `lib/stages.ts` `STAGE_TRANSITIONS`, `decideStage`. |

**Does well.** SB: independent reviewer agent that re-runs tests and "remembers prior findings" (evaluator–optimizer), dependency-aware waves from `## Blocked by` sections, auto-unblock sweep. MF: a real state machine with typed causes, attempt numbers and per-attempt branches (`factory/FAC-7-a2`).

**Lacks.** SB: Stages cannot be added, removed or reordered; the lifecycle lives in ~800 lines of prose (`run.md`) that an LLM must follow. MF: no independent review Stage at all; "review" is Bugbot (an external paid bot) plus the owner. Stages are also not configurable.

**For v1.** Combine: MF's explicit, cause-keyed transition table as the *engine*, with SB's separate per-Stage agents (build / verify / review) as *configurable Stage definitions*. Neither project lets a user define Stages, which is v1's core promise.

### 2. Policies and merge gates

| | super-board | marshal-factory |
|---|---|---|
| Autonomy | `merge_policy.default: auto | human`; legacy `human_approves_merge`. SB: config-schema `merge_policy`. | Per repo `off | trial | auto` ("Merge when confident"). Trial computes and shows "Would merge" without merging. MF: `lib/merge-decision.ts` `AUTONOMY_LEVELS`; `docs/operations.md` "Merge decisions". |
| Risk rules | `always_human` categories (money, auth, schema) matched by label, path glob and added-line keyword; `auto_max_lines` 400 with lockfile/generated excludes; migration Policy with `allowed_envs` (test, staging, never live). | Hard limits only: failed check, conflict, unresolved medium/high Bugbot finding, `review` label, no evidence at head, UI files changed without screenshots. Size and protected paths were removed and left to the agent's confidence. |
| Proof | Merge gate takes a lock, checks PR head equals the reviewed SHA, merges current base into a scratch worktree, runs `verify_commands`, squash-merges with `--match-head-commit`. Missing `verify_commands` halts. SB: `scripts/super-board-merge-gate.sh`, docs README "Nothing merges on GitHub's word". | Evidence bound to exact head SHA from a clean tree (`factory-verify`); runner can re-run checks itself in a sandbox. A PR that edits the recipe, `package.json` scripts or `.github/workflows/**` is "untrusted" evidence and hands over. MF: `lib/evidence.ts`, `lib/trusted-checks.ts`. |
| After merge | Worktree cleanup only. | 60-minute post-merge watch on base; red main triggers an automatic revert PR, merged at once. MF: operations "Watching main after a merge". |

**Does well.** SB: rich, declarative risk Policies and merge-against-current-base. MF: graduated autonomy with a trial mode, head-pinned evidence, refusing evidence when the PR edits its own checks, and auto-revert.

**Lacks.** SB: no trial/dry-run of the merge decision, no post-merge watch. MF: dropped declarative risk rules in favour of LLM confidence; the agent's self-assessed `confident` flag is a merge input, which is weak against a confidently wrong agent; heavy dependence on Bugbot.

**For v1.** Policies should be declarative and composable: SB's `always_human` + size cap + MF's hard limits + MF's `off | trial | auto` ladder. Steal both SB's "merge current base and re-verify under a lock" and MF's "evidence must match head SHA and the PR must not touch its own checks". Add MF's post-merge watch as an optional Policy.

### 3. Job state storage

| | super-board | marshal-factory |
|---|---|---|
| Store | GitHub Projects board columns + assignee as mutex + machine-readable lines in comments (`blocked-by:`, `root-cause-hash:`, `approval-request:`). Lockfiles under `.claude/super-board/inflight/`. "The board is the only state." | Postgres (Neon) via Drizzle: `jobs`, `events`, `runs`, `agents`, `intents`, `audit_log`, `job_evidence`, ... 40 migrations. MF: `db/schema.ts`, `drizzle/`. |
| Durability | Resume = re-run; state re-read from the board. Survives Ctrl-C. | Reporter writes each event to a local file outbox before POSTing; ordered flush; ingest dedupes by event id. MF: operations "Reporting" → "Outbox". |
| Cost of it | GraphQL rate limits dominate: ~103 points per tick, 120 s tick floor, quota guards and a rate-limit etiquette doc for workers. SB: docs README "Safety controls", `references/rate-limit-etiquette.md`. | Requires a cloud database, realtime and an ingest Function even for one user. |

**For v1.** Local-first: a SQLite (or append-only JSONL) event log as the source of truth for Job state, written through an MF-style outbox so a crash never loses events, and projected outward to GitHub (labels, comments) for visibility. Avoid SB's "GitHub is the database" (rate limits, parsing prose) and MF's hosted stack. The event log doubles as the feed for a future panel.

### 4. Human-in-the-loop

| | super-board | marshal-factory |
|---|---|---|
| Questions | Lanes must never ask. A Job that cannot proceed goes to Blocked with a strict template (reason, evidence, owner, checklist, `blocked-by:`). SB: `references/block-template.md`. | The agent reports `waiting` with a question and 2–3 concrete options, posted on the Linear issue; the reply resumes the same branch. MF: `playbooks/factory.md` "Blocked or ambiguous means waiting", "Resumed runs". |
| Approvals | Human comments `done` on a pinned `approval-request:` that hashes the PR head and required steps; only repo collaborators count; labels never authorize. SB: `scripts/super-board-approval.py`. | Inbox in the panel and Slack buttons: Approve and merge, Request changes (wakes thread, moves to implementing), Retry with note, Answer. MF: operations "Needs you inbox". |
| Pre-flight | `super-board lint` flags vague acceptance criteria before a run. | Triage Stage runs an "ambiguity test": write the acceptance check from the issue text or go to `waiting`. |

**For v1.** Steal MF's `waiting` + structured question + resume-on-reply (via a GitHub issue comment instead of Linear), SB's head-and-scope-pinned approval token, and SB's block template's machine line. GitHub comments are the v1 human channel; the event log keeps the seam for a panel/Slack later.

### 5. Cost tracking

- **SB** tracks no money. It reads Claude plan usage percentages captured from the status line and pauses new waves at 95% of the 5-hour/weekly window; it says plainly that headless and API-key users get `unknown`. SB: `scripts/super-board-usage.sh` header comment.
- **MF** prices tokens per attempt (main session + subagents) from hook usage snapshots every 30 s and Codex session logs, with a price table and overrides; cost is `known: false` when any model is unpriced. It **removed** its budget cap: "Spend is measured per attempt... no amount stops a run"; `hooks/budget.ts` is now a no-op. MF: `lib/spend.ts`, `lib/pricing.ts`, operations "Spend", "Cost".

**For v1.** MF's per-attempt, per-Stage cost events with an explicit `known` flag are the model. Budget should exist as a Policy (soft warn / pause before next Stage, not mid-tool-call kill), since MF's experience shows a hard mid-run cap was unwelcome. SB's plan-window pause is a useful second Policy for subscription users.

### 6. Security

| | super-board | marshal-factory |
|---|---|---|
| Agent sandboxing | PreToolUse guard hooks: worktrees only under `.claude/worktrees/`, no reading dotenv/SSH/credential files, no API-key literals written, no `rm` outside project, optional protected-main push block. SB: `hooks/`. | Optional Modal sandbox per Job (isolation, 4 h limit); local mode shares the Mac. Playbook rules: never merge, never push main, never `pkill` by name. |
| Credentials | Agents use the user's `gh` token; merge needs `Bash(gh pr merge:*)` allowlisted. | Runner merges as a GitHub App (contents/PRs/checks/issues write); agents still push with the user's `gh`. Repo secrets live in Modal secrets, never in the DB. Log/evidence redaction of known token shapes. MF: `scripts/setup-github-app.ts`, operations "Redaction", "Secrets". |
| Code review | `pr-security-review` (ported from Anthropic's) on every PR inside QA; findings fail QA. | Bugbot findings gate merges. |
| Webhooks/panel | n/a | HMAC-verified Slack and webhook signatures; owner-only actions. |

**Lacks in both.** Neither treats issue bodies as untrusted input to an agent with write access (prompt injection from whoever can file or edit an issue). Neither restricts which issue authors can trigger a Job beyond "has the label". MF's merge is gated partly on the agent's own claim of confidence.

**For v1.** Steal SB's guard hooks (portable, stdlib, testable) and MF's "only the orchestrator merges, the agent never does" split. Add: an author allowlist for Jobs, issue text framed as untrusted data in the Stage prompt, and least-privilege credentials per Stage (the build agent needs push to `factory/*`, not merge).

### 7. Configuration surface

- **SB**: one JSON file per board in the Target repo (`.claude/super-board/configs/<slug>.json`), documented by a commented schema: merge Policy, migrations, `verify_commands`, `rebuild_cap`, `max_workers`, `model_tier`, host. Rich but monolithic; Stages and labels are hard-coded. SB: `references/config-schema.json`.
- **MF**: split across `~/.config/marshal-factory/config.json` (limits, pricing, repos), a `settings` DB row edited in the panel (harness, model, run location), per-repo `repo_settings` (autonomy, Bugbot), per-repo `.factory/setup.json` recipe (system packages, runtimes, setup, checks, env names) and per-ticket label overrides (Harness, Runs on, Repository) with precedence ticket > repo > global. MF: `lib/config.ts`, `lib/recipe.ts`, operations "Per-ticket overrides".

**For v1.** One typed (zod) config file for the Factory plus a per-Target-repo file (MF's recipe idea: setup, checks, env *names*), with MF's three-level precedence (Job label > Target repo > Factory default). Stages and Policies must be first-class config, which neither offers.

### 8. Install and onboarding

- **SB**: `curl | bash` or Claude Code plugin, then `/super-board onboard`, an 8-step resumable wizard (checks, GitHub auth, board, branch, AGENTS.md, Policies, bug sources, review) that auto-fixes must-haves and asks only for system installs or sign-in; writes all files once at the end. Strong. Cost: it installs scripts, hooks and skills *into each Target repo* and depends on mattpocock/skills and others by name. SB: docs README "Onboarding".
- **MF**: nine manual steps across Linear, Neon, Vercel, GitHub App, launchd, editing source to rename the App and pin the production DB endpoint. Heavy. But repo onboarding is excellent: an agent writes `.factory/setup.json`, runs every check until green, and opens a PR "Add the factory setup recipe"; secrets requested by name. MF: `README.md` "Install", operations "Onboarding a repository", `playbooks/onboarding.md`.

**For v1.** SB-style resumable `factory init` wizard for the Factory, MF-style agent-written, PR-reviewed recipe for each Target repo. Keep the Factory's code out of Target repos where possible (MF's "playbook ships with the factory; the repo copy only adds notes").

## Ranked list: what to steal

1. **Explicit Stage transition table keyed by cause, idempotent by event id** (MF `lib/stages.ts`). The engine for configurable Stages; makes retries, replays and late events safe.
2. **Head-pinned merge gate**: lock, merge current base, re-run verify commands, merge with `--match-head-commit` (SB), plus evidence bound to the head SHA and refused if the PR edits its own checks (MF `lib/trusted-checks.ts`).
3. **Autonomy ladder `off | trial | auto` per Target repo** (MF), with trial showing "would merge" decisions so trust is earned on data.
4. **Declarative risk Policies**: `always_human` by label/path/keyword, size cap with lockfile excludes, migration env rules (SB `merge_policy`, `migrations`).
5. **Separate review Stage agent** that re-runs tests and re-checks its prior findings on re-review (SB `super-review`), instead of MF's self-assessment.
6. **`waiting` Stage with a structured question and resume-on-reply on the same branch** (MF playbook), and **no lane ever prompts interactively** (both).
7. **Event outbox**: write-to-disk-then-send, ordered flush, dedupe by id (MF reporter). Fits "every run emits structured events".
8. **Per-attempt cost with a `known` flag and price table** (MF `lib/spend.ts`, `lib/pricing.ts`); attempts get their own branch.
9. **Guard hooks** for worktree paths, secret files, key literals, deletes outside project (SB `hooks/`).
10. **Agent-written Target repo recipe delivered as a PR** (MF onboarding) and **resumable onboarding wizard** (SB).
11. **Watchdog**: nudge once after quiet N minutes, fail after a second window (MF); **rebuild cap with root-cause hash** to stop bounce loops (SB).
12. **Machine-readable line under human prose** in every bot comment (`blocked-by:`, `approval-request:`), and head-plus-scope-hashed approvals from collaborators only (SB).
13. **Post-merge watch with auto-revert** (MF), as an optional later Policy.

## Missing from both

1. **User-configurable Stages and Policies.** Both hard-code their pipeline; v1's main differentiator.
2. **Local-first durable Job store.** One uses GitHub as a database (rate limits, prose parsing), the other needs a cloud Postgres. Neither offers a local SQLite/JSONL event log.
3. **Prompt-injection posture.** No author allowlist and no framing of issue text as untrusted input to a write-capable agent.
4. **Budget as a Policy.** SB tracks no dollars; MF measures but removed its cap. Nobody does a soft per-Job or per-Stage budget with pause-before-next-Stage.
5. **Agent-agnostic Stage contract.** Both bend around Claude Code specifics (dynamic workflows, hooks) with Codex bolted on; neither defines a clean per-Stage executor interface with structured input/output.
6. **Least-privilege credentials per Stage.** Build agents in both push with the user's full `gh` token.
7. **A documented, versioned event schema** for a panel. MF has events but they are implicitly defined by its DB and ingest; SB emits none.
8. **Self-improvement from Job history** is only a bolt-on in SB (optional external `calibrate` skill, `references/calibration.md`) and absent in MF.
9. **Cross-Job conflict handling up front.** SB does a file-overlap pre-flight; MF reacts to conflicts after the fact. Neither plans concurrency around predicted file overlap in a principled way.
