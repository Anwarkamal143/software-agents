# Software Factory

A configurable system that turns tracked work items into reviewed, merged pull requests with minimal human babysitting.

## Language

**Factory**:
The whole system: its sources, pipeline, policies and executor, configured for one or more target repos.
_Avoid_: board, platform, orchestrator (as a name for the whole)

**Job**:
One unit of work travelling through the Factory, from a tracked issue to a merged (or abandoned) pull request.
_Avoid_: task, run, card, ticket

**Source**:
Where Jobs come from, such as GitHub Issues. A Source only reads; everything written back goes through a Mirror.
_Avoid_: intake, inbox

**Stage**:
One step a Job passes through in the pipeline, such as build, QA or review.
_Avoid_: lane, phase, step

**Policy**:
A configured rule that governs a Job's progress, such as a merge gate, an autonomy level or a budget.
_Avoid_: rule

**Target repo**:
A repository the Factory does work in, with its own verify commands and conventions.
_Avoid_: project, workspace

**Orchestrator**:
The Factory's own program that owns Job state, Stage order, Policies and every merge. Agents work inside it and never replace it.
_Avoid_: runner, daemon, board

**Agent adapter**:
The single seam through which the Orchestrator runs one Stage on a particular agent (such as Claude Code or Codex) and gets back its events and result.
_Avoid_: harness, driver, executor

**Factory plugin**:
The Stage instructions (prompts and skills) loaded into each agent session. It holds behaviour, never control logic.
_Avoid_: skill pack, playbook

**Guard**:
A block the Orchestrator places on a single agent action, such as reading a secret file or writing outside the Job's working copy. A Guard stops a tool call; a Policy governs a Job's progress. Every denial is recorded in the Event log.
_Avoid_: hook (for the concept), Policy

**Sandbox**:
The operating-system confinement every command in a Stage run executes inside, agent or Check Stage alike, limiting what files it can write and what network it can reach. A run that can't be sandboxed doesn't run.
_Avoid_: container, jail, isolation (alone)

**Job approval**:
An allowed person applying the ready label to an issue, which is what admits it to the Factory. Who wrote the issue doesn't matter; an edit afterwards needs approval again unless an allowed person made it.
_Avoid_: intake, acceptance, triage

**Pre-push check**:
What the Orchestrator verifies about an agent's local commits before it pushes them to the Job branch itself. Agents never push.
_Avoid_: pre-commit hook, push gate

## Job lifecycle

**Job status**:
Where a Job stands, independent of the pipeline: queued, running, waiting, paused, merged, failed or cancelled. A Job always has both a current Stage and a Job status.
_Avoid_: state, column, phase

**Stage run**:
One agent session executing one Stage for one Job.
_Avoid_: run, session (alone), execution

**Attempt**:
A fresh start of a Job from the default branch, on its own branch. A retry after failure or a reset begins a new Attempt.
_Avoid_: retry (as a noun), iteration

**Working copy**:
An Attempt's own clone of the Target repo, the only place its agents may write. The Orchestrator treats it as untrusted and never runs git inside it.
_Avoid_: worktree, checkout, workspace

**Trusted clone**:
The Factory's own clone of a Target repo, which agents never touch. Every push, rebase and merge happens from it.
_Avoid_: mirror (a Mirror is something else), cache, main checkout

**Bounce**:
Sending a Job back to an earlier Stage because a later Stage failed it, carrying that Stage's findings along.
_Avoid_: rebuild, rework, rejection

**Event log**:
The append-only record of everything that happened to every Job, one entry per fact, whose type is its cause. Job state is computed from it.
_Avoid_: history, audit log, activity feed

**Transcript**:
The raw record of one Stage run's agent session: every message, tool call and token count. Events point to it; Job state never depends on it.
_Avoid_: log (alone), trace, session history

**Job store**:
The single authoritative home of the Event log. Every transition is decided against it.
_Avoid_: database, backend (alone), source of truth

**Mirror**:
A copy of Job state written out for visibility, such as GitHub labels, status comments and what a Job's ending shows (its PR closed or turned back into a draft, a reverted issue reopened). It only shows what the Orchestrator already decided: it never decides anything, and nothing is decided from it.
_Avoid_: replica, sync, projection (for GitHub)

**Human request**:
What the Factory posts when a Job goes to waiting: a question with lettered options, or a request for approval, along with the Reply commands that answer it.
_Avoid_: prompt, ping, escalation

**Reply command**:
The only form in which a human's reply is read back: a fixed command from an allowed person, such as answer, approve, reject or cancel. Free text is never interpreted.
_Avoid_: answer comment, response

## Stages and pipelines

**Pipeline**:
A named, ordered list of Stages that a Job goes through, chosen by issue label or by the Target repo's default.
_Avoid_: workflow, flow, lanes

**Agent Stage**:
A Stage carried out by an agent session following Factory plugin instructions.
_Avoid_: lane, worker, agent step

**Check Stage**:
A Stage carried out by a deterministic command the Orchestrator runs itself, with no agent involved.
_Avoid_: gate (for this), CI step

**Stage brief**:
Everything the Orchestrator hands a Stage run: the issue text marked as untrusted, the branch, the Attempt and Bounce numbers, earlier Stage results, the Target repo's conventions, and the Stage's instructions.
_Avoid_: prompt, context, input

**Stage result**:
The structured outcome of a Stage run: a Verdict, a summary, findings, an optional question, and artifacts, alongside facts the Orchestrator measured itself.
_Avoid_: output, report

**Verdict**:
A Stage's claim of pass, fail or needs-human. It decides where the Pipeline goes next and is never proof.
_Avoid_: confidence, status

**Run error**:
A Stage run that broke rather than judged: a crash, a timeout, a hard Budget hit or a result that doesn't fit the schema. It is retried; a fail Verdict is not a Run error and Bounces instead.
_Avoid_: failure (alone), stage failure, crash (for all of these)

**Evidence**:
Proof the Orchestrator produced itself, tied to an exact head commit, such as Check Stage output. Only Evidence can satisfy a merge gate.
_Avoid_: proof (from an agent), test claims

**Tool profile**:
What a Stage is allowed to do: read-only, or write to the Job's branch. Guards apply on top.
_Avoid_: permissions (alone), mode

## Policies

**Autonomy level**:
How far the Factory may go on its own in a Target repo: off (you merge, or `/approve` and the Factory merges), trial (the same, and the Factory says whether it would have merged), or auto (the Factory merges when the Merge gate passes).
_Avoid_: merge mode, confidence mode

**Merge gate**:
The Orchestrator's final check before merging. Its core requirements are fixed and cannot be configured; Policies can only add to them.
_Avoid_: merge Stage, approval step

**Risk rule**:
A Policy that sends a Job to a human whatever the Autonomy level, matched by label, path, a keyword in added lines, or change size.
_Avoid_: always-human, protected path (alone)

**Budget**:
A limit on estimated dollars, turns or wall-clock time for a Stage run, a Job or the whole Factory per day.
_Avoid_: quota, cap (alone), spend limit

**Checkpoint**:
A fixed moment when the Orchestrator evaluates Policies: before a Stage run, after a Stage result, at the Merge gate, and after a merge.
_Avoid_: hook, trigger

## Configuration

**Factory home**:
The folder on your machine that holds the Factory's configuration, Job store and artifacts. Target repos never contain Factory configuration.
_Avoid_: workspace, project folder

**Stage library**:
The set of Stages defined once in Factory configuration, which Pipelines refer to by name.
_Avoid_: stage registry, templates

**Baseline check**:
Running a Target repo's verify commands on its default branch, which must pass before the Factory takes Jobs there. A red baseline would fail every Job.
_Avoid_: smoke test, health check

**Factory-wide value**:
A setting that only the Factory layer may set, because it applies across all Target repos: the daily Budget, sign-in mode, Job store and Mirrors.
_Avoid_: global (alone)
