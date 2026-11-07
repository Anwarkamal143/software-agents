# software-agents

The Software Factory turns approved GitHub issues into reviewed, merged pull requests. Vocabulary is in `GLOSSARY.md`, decisions in `docs/adr/`.

## Install and set up

Needs Node 22.13 or later. On Linux the Sandbox needs `bubblewrap` and `socat`.

```sh
npm i -g software-factory
factory init                      # Factory home, your own GitHub App, a starter factory.yaml, pinned gitleaks
factory repo add <owner/repo>     # propose Check Stages and a network allowlist, run the Baseline check
factory secret set <owner/repo> DATABASE_URL < value.txt   # a check secret, read from stdin into the keychain
factory doctor                    # the self-checks every start runs; --baseline adds each repo's Baseline check
factory run
```

`factory init --token` stores a personal token (read from stdin) instead of creating a GitHub App. `factory repo add --backfill` also picks up issues already labelled `factory:ready`. Apply `factory:ready` to an issue to start a Job.
