# Factory configuration lives in the Factory home, never in a Target repo

All Factory configuration (Stage library, Pipelines, Policies, Target repos, label overrides) is one file, `factory.yaml`, in the Factory home on your machine. Many tools keep their config in the repo they act on (`.github/`, `.super-board/`). We rejected that because a Job's own PR could then edit the Policies, verify commands and Risk rules that judge it, which is exactly what the Merge gate's "doesn't edit its own checks" rule exists to stop (ADR 0004). A Target repo contributes only its ordinary conventions (CLAUDE.md or AGENTS.md), which reach agents as text in the Stage brief.

## Consequences

- Onboarding a Target repo means editing `factory.yaml` in the Factory home, not committing to the repo.
- Verify commands for a repo live in Factory config, so a PR changing `package.json` scripts still makes its Evidence untrusted.
