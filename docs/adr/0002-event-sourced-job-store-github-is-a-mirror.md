# Event-sourced Job store with a pluggable backend; GitHub is only a Mirror

Job state is an append-only **Event log** with a named cause on every entry, kept in exactly one authoritative **Job store**, chosen in config: SQLite (the default) or Postgres in v1. Any number of **Mirrors** (GitHub always, plus optionally Postgres for a future panel) receive copies through an outbox that saves each event to disk before sending, and they never decide anything. We rejected super-board's "the GitHub board is the only state" because it has no transactions, hits GraphQL rate limits, and depends on parsing comment text. We rejected marshal-factory's hosted Postgres as the only option because a single user shouldn't need a cloud database. We rejected writing to several stores at once because they would disagree with no rule for which one wins.

## Consequences

- A Job's status (queued, running, waiting, paused, merged, failed, cancelled) is separate from its current Stage, so the pipeline stays configurable.
- The only things read back from GitHub are human inputs (a ready label, an answer comment, a PR merged or closed). They enter the Event log as events with causes.
- Switching backends means exporting and replaying the Event log, not migrating a schema.
- A Mirror that is down never blocks a Job; only a Job store failure does.
- GitHub as a Job store is left open behind the store interface but not built in v1.
