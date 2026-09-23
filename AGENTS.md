# Factory contributor rules

These instructions are for human and agent contributors **building Factory in this repository**. They govern source extraction, slice scope, implementation, tests, review, and handoff. End-user instructions for using the installed plugin belong in the [README](README.md) and packaged `director`/`setup` skills; contributors do not invoke Factory Director to build Factory.

Read [the public implementation plan](docs/IMPLEMENTATION-PLAN.md), [current build status](docs/BUILD-STATUS.md), and the current [project issue](https://github.com/orgs/clockgrove/projects/2) before changing code. These public files and issues are the complete contributor handoff; private adopter material is never required. Factory is a plugin for a target repository, not a hosted service. Never install, activate, or qualify it against a Factory source checkout. Use a disposable target built from [the public fixture](test/fixtures/disposable-target/).

## Priority

Ship the trunk through one path: Objective → Work Item DAG → local execution → exact validation → GitHub delivery → Objective final validation. Trunk includes native linear PR stacks, media assets, large content, Git LFS, restart/cancel/status, and packaging. Private adopter pilots follow the disposable release gate built from public fixtures and use the public plugin surface exactly as a third party would.

After the trunk, add the managed cloud agent driver, then the sandbox driver and BYO harness, then Daytona. Bursting, mixed modes, live migration, adaptive pressure, distributed controllers, and compounded fault matrices are leaves.

## Scope

Start from the current issue's outcome and the relevant section of the public plan. A finding is a blocker only when it prevents that path; record useful follow-ups without making them blockers. Stop when accepted behavior and focused validation pass. The target repository owns product requirements, documentation authority, commands, branch protection, and Objective exit conditions. Work Item completion does not imply Objective completion.

## Design

Build successive vertical slices. Define narrow contracts for the named variation points: PlanningModel, ExecutionDriver, AgentHarness, SandboxProvider, DeliveryStrategy, ContentStore, and GitHubGateway. Compose only implementations needed by the current slice. Do not abstract the state store, scheduler, lifecycle, validator, runner, Git model, or controller host.

Use one atomic local snapshot. Do not add event logs, receipts, journals, custom state refs, provider ranking, fallback chains, or qualification machinery. MediaAssetService preserves immutable bytes, AssetSets, provenance, review, selection, and bindings; the configured AgentHarness owns model and tool execution. Media reenters ordinary validation and delivery.

The rebuild starts at schemaVersion 1 and reads no archived configuration or state. Inspect only archived paths named by the current slice in [SOURCE-PROVENANCE.md](docs/SOURCE-PROVENANCE.md) and the public plan; record retained behavior and clean destination. Copy no archived runtime, tests, or fixtures. Do not invent Factory limits beneath dependencies or operator policy. Failure stops with evidence; retry is explicit; ambiguous external state requires operator direction.

Use low reasoning effort for focused implementation and routine tests, medium for architecture and unfamiliar debugging, and higher only for a concrete blocker. Review the accepted diff once, batch findings, fix blockers, run affected checks, and stop. Prefer deterministic integration scenarios with real temporary Git repositories; stub remote services at narrow contracts.

After a slice gate, update [BUILD-STATUS.md](docs/BUILD-STATUS.md), the tracking issue, and the provenance ledger so a new contributor can resume from the public repo alone. Report current slice, proven behavior, blocker, next action, and whether remaining work is trunk, branch, or leaf.
