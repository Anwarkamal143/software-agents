# Each user creates their own GitHub App through the manifest flow

The Factory acts on GitHub as a GitHub App (ADR 0007), and every user creates their own private App rather than installing one the project publishes. `factory init` opens GitHub's App manifest flow pre-filled with exactly the permissions the Factory needs (contents, pull requests and issues read/write; checks and metadata read; no webhooks); you click "Create" and install it on your Target repos, and a one-time `localhost` callback hands the App id and private key straight to the OS keychain. We rejected a shared, project-published App: it would be one click simpler, but its private key could act on every user's repos, so whoever holds it becomes a target, and a self-hosted, solo Factory has no server to keep it on. A personal token stays as the `--token` fallback.

## Consequences

- Onboarding is three commands: `factory init` once per machine (Factory home, App and credentials, pinned tools), `factory repo add <owner/repo>` once per Target repo, and `factory doctor` for the self-checks.
- `factory repo add` makes the Trusted clone, creates `factory:ready` and the `factory:<status>` labels, and proposes Check Stages and network allowlist entries from what it finds (for example `package.json` scripts and lockfiles) for you to confirm or edit before writing the repo's entry in `factory.yaml`. It then runs a Baseline check; a red baseline refuses the repo unless `--skip-baseline`.
- The first poll of a new repo starts from when it was added; `--backfill` also picks up issues already labelled `factory:ready`, each still checked in the timeline for an allowed person.
- `factory secret set <repo> <NAME>` reads check secrets from stdin into the keychain; `factory.yaml` only names them.
- Pre-push checks scan the Job's diff with gitleaks, a pinned version that `factory init` installs into the Factory home and checks by checksum. Missing or the wrong version is a Factory fault.
- Self-checks run at every start and in `factory doctor`: both sandboxes available, keychain readable, App token mintable with the needed permissions per installation, gitleaks at its pinned version, Job store writable, `factory config check`, and agent sign-in matching the configured mode. The Baseline check runs only at `repo add` and with `factory doctor --baseline`.
- The Factory installs as an npm package on Node 22 or later. On Linux, `factory init` checks for `bubblewrap` and gives the install command if it's missing.
