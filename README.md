# Factory

Factory is an open-source plugin installed for one target repository. It compiles a human Objective into a dependency-aware Work Item graph, executes through a configured harness, validates exact results, and delivers them through GitHub.

This repository is a fresh implementation. The Slice 1 package supports one local Work Item per Objective, independent exact-tree validation, one regular GitHub PR, and final validation. Concurrency, restart, native stacks, media, and LFS follow in later slices.

## Development

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm pack
```

Install the packed artifact in a clean environment, then bind it to a target checkout:

```sh
factory install --repository OWNER/REPO --checkout /absolute/path --concurrency 1
factory run --objective ISSUE_NUMBER
factory status --objective ISSUE_NUMBER
```

The installation writes private configuration under `$XDG_CONFIG_HOME/clockgrove-factory` or `~/.config/clockgrove-factory`. State is reserved under `$XDG_STATE_HOME/clockgrove-factory` or `~/.local/state/clockgrove-factory`. Neither belongs in the target repository. Managed-agent and sandbox modes are reserved schema shapes and fail preflight until implemented.

Factory refuses its own repository as a target. The archived source repository remains separate during the staged cutover.

## Roadmap

The project issues track Slice 0–5 acceptance and later managed-agent and sandbox branches.
