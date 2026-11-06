# Agent Verdicts route the Pipeline; only Orchestrator Evidence gates a merge

An agent Stage's Verdict (pass, fail or needs-human) decides only where the Job goes next. A merge gate can be satisfied only by Evidence the Orchestrator produced itself, tied to the exact head commit, such as Check Stage output. Merging is not a Stage at all: it is the Orchestrator's merge gate, which runs after the last Stage passes. We rejected trusting an agent's self-reported confidence, as marshal-factory partly does, because a build agent's "tests pass" is a claim made by the party being checked.

## Consequences

- A useful Pipeline needs at least one Check Stage (for example the Target repo's verify commands) before the merge gate can ever pass.
- Stage results must keep agent claims separate from facts the Orchestrator measured (cost, tokens, head commit, files changed).
