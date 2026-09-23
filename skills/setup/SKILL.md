---
name: setup
description: Install and bind one Factory configuration to a target GitHub repository and checkout without starting Objective execution.
---

# Factory setup

Confirm the target is a Git repository outside all Factory source, rebuild, and archive repositories. Obtain the operator's positive concurrency choice, repository `OWNER/REPO`, absolute checkout path, and regular or native-stack delivery choice. Keep credentials outside repositories. Use `factory install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N` with `--delivery native-stack` only when requested. Report the installed binding and configuration path printed by the CLI. Do not start work during setup.

Factory requires an empty configuration and state root at installation; use a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for an isolated trial. `factory install` validates the local Codex SDK harness, delivery strategy, and network policy. Local execution is the implemented shape. Managed-agent and sandbox shapes are reserved; report their unsupported result until their branches ship. The target repository remains authoritative for its instructions and validation.
