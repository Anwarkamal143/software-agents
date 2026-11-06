# Policy overrides can only tighten, and the Merge gate's core is fixed

In an otherwise configurable Factory, two things are deliberately not configurable. First, Policy values resolve Factory default → Target repo → Pipeline → issue label, but a Pipeline or label may only make a Policy stricter, never looser. Anyone who can label an issue could otherwise turn on auto-merge. Second, the Merge gate's core requirements cannot be switched off at any Autonomy level: every Stage passed at the head commit, Evidence for that commit, green checks, no conflicts, the PR does not edit its own checks, and a locked re-verify against the current base before a `--match-head-commit` merge. We rejected marshal-factory's approach of relaxing hard limits in favour of agent confidence.

## Consequences

- Loosening a Policy means changing Target repo or Factory config, which is under your control, not issue metadata.
- A Target repo without a Check Stage can never pass the Merge gate (see ADR 0003).
- Past the daily Budget, no new Stage runs start, including for Jobs already in flight; running Stage runs finish (reconciled while writing the v1 PRD; Policies, #8, had said "no new Jobs").
- "Every Stage passed at the head commit" means every Stage from the first one that passed the final head onward passed exactly that commit; Stages before it, such as triage, only need to have passed. Read literally no Job could pass, because triage always runs before build writes the head. Evidence for that exact commit is required separately (clarified while implementing Policies, #25).
- After the locked re-verify rebases the Job branch, the Check Stages rerun on the new head, and agent Stage passes carry over from the pre-rebase head: a clean rebase changes no lines they judged.
- `/approve` overrides Risk rules and Autonomy, never the core: in off and trial it tells the Factory to merge, through the same locked re-verify. Without it, the Factory never merges in off or trial.
- A post-merge revert reopens the issue with a comment saying why, but starts no new Job: only an allowed person's ready label approves work (ADR 0007).
