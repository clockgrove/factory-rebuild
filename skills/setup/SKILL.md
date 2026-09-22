---
name: setup
description: Install and bind one Factory configuration to a target GitHub repository and checkout without starting Objective execution.
---

# Factory setup

Confirm the target is a Git repository outside all Factory source, rebuild, and archive repositories. Obtain the operator's positive concurrency choice and bind the repository name and absolute checkout. Keep credentials outside repositories. Use `factory install`, then read back and validate schemaVersion 1 configuration. Do not start work during setup.

Local execution with the Codex SDK harness is the implemented shape. Managed-agent and sandbox shapes are reserved; clearly report their unsupported preflight result until their branches ship. Validate the selected harness, local content store, delivery strategy, network policy, and empty Factory state root. The target repository remains authoritative for its instructions and validation.
