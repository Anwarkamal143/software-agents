# Policy overrides can only tighten, and the Merge gate's core is fixed

In an otherwise configurable Factory, two things are deliberately not configurable. First, Policy values resolve Factory default → Target repo → Pipeline → issue label, but a Pipeline or label may only make a Policy stricter, never looser. Anyone who can label an issue could otherwise turn on auto-merge. Second, the Merge gate's core requirements cannot be switched off at any Autonomy level: every Stage passed at the head commit, Evidence for that commit, green checks, no conflicts, the PR does not edit its own checks, and a locked re-verify against the current base before a `--match-head-commit` merge. We rejected marshal-factory's approach of relaxing hard limits in favour of agent confidence.

## Consequences

- Loosening a Policy means changing Target repo or Factory config, which is under your control, not issue metadata.
- A Target repo without a Check Stage can never pass the Merge gate (see ADR 0003).
