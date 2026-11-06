# The Event log records facts named by their cause; Transcripts are kept apart

Every Event log entry is a fact whose **type is its cause** (`stage-passed`, `human-answered`, `pr-merged`); Job status is always computed from those facts and never stored as a "status changed" event, and a move the rules don't allow is itself recorded as `transition-rejected`. The Event log holds only Job and Factory facts. Each Stage run's raw agent session messages go into a separate **Transcript** (NDJSON in the Factory home) that events point to by Stage run id. We rejected one combined stream: a session emits thousands of lines that decide nothing, which would bloat the authoritative record, slow replay and push raw agent output toward Mirrors. We rejected a separate `cause` field next to a status-change type because it says the same thing twice and the two could disagree.

## Consequences

- Every event carries `id` (ULID), a global `seq` (the read cursor), `type`, a per-type `schema_version`, `at`, `job_id` / `attempt` / `stage_run_id` (null for Factory-wide events), `actor` (`orchestrator`, `stage:<name>`, `human:<login>`, `cli`), an optional `caused_by` event id, and `data`. Cost, tokens, turns and duration ride on the Stage-ending events.
- v1 types cover every Job status move and every Merge gate and Policy decision, grouped as Job, Stage run, Evidence and Guards, Policies, Humans, Merging, Factory-wide and bookkeeping (full list in Event schema and observability, #16). Adding a type later is cheap.
- Events are never rewritten. A change bumps that type's `schema_version` and readers upgrade old versions as they read; unknown types are kept and skipped.
- Large outputs (check logs, diffs, Stage result artifacts) are files named by sha256, referenced by hash and size, so Evidence points at exact bytes.
- The Job store's `read(fromSeq)` / `follow(fromSeq)` is the only reading seam. `factory status`, `factory logs <job> --follow` (events plus the live Transcript) and `factory events --json` are built on it, as a future panel will be (or on a Postgres Mirror). No OpenTelemetry in v1; totals are queries over the Event log.
- The Event log is kept forever. Transcripts and artifacts are deleted 30 days after a Job ends (configurable), except Evidence behind a merge, which lives as long as its Job.
- Before a Transcript line is written, exact values of Factory credentials and check secrets become `[redacted:<name>]`. Transcript and artifact files are mode `600` and never go to a Mirror.
