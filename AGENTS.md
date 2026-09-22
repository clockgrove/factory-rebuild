# Factory contributor rules

Factory is an open-source plugin installed for a target repository. It is not a hosted service. Never install, activate, or qualify Factory against the Factory repository; use Clockgrove or an explicit disposable fixture.

## Priority

Ship the trunk through one path: Objective → Work Item DAG → local execution → exact validation → GitHub delivery → Objective final validation. Trunk includes native linear PR stacks, media assets, large content, Git LFS, restart/cancel/status, packaging, and the Clockgrove foundation pilot.

After the trunk, add the managed cloud agent driver, then the sandbox driver and BYO harness, then Daytona. Bursting, mixed modes, live migration, adaptive pressure, distributed controllers, and compounded fault matrices are leaves.

## Scope

Start from the current issue's outcome and acceptance. A finding is a blocker only when it prevents that path; record useful follow-ups without making them blockers. Stop when accepted behavior and focused validation pass. The target repository owns product requirements, documentation authority, commands, branch protection, and Objective exit conditions. Work Item completion does not imply Objective completion.

## Design

Build successive vertical slices. Define narrow contracts for the named variation points: PlanningModel, ExecutionDriver, AgentHarness, SandboxProvider, DeliveryStrategy, ContentStore, and GitHubGateway. Compose only implementations needed by the current slice. Do not abstract the state store, scheduler, lifecycle, validator, runner, Git model, or controller host.

Use one atomic local snapshot. Do not add event logs, receipts, journals, custom state refs, provider ranking, fallback chains, or qualification machinery. MediaAssetService preserves immutable bytes, AssetSets, provenance, review, selection, and bindings; the configured AgentHarness owns model and tool execution. Media reenters ordinary validation and delivery.

The rebuild starts at schemaVersion 1 and reads no archived configuration or state. Archived source is usable only when named in `docs/SOURCE-PROVENANCE.md`. Copy no archived tests or fixtures. Do not invent Factory limits beneath dependencies or operator policy. Failure stops with evidence; retry is explicit; ambiguous external state requires operator direction.

Use low reasoning effort for focused implementation and routine tests, medium for architecture and unfamiliar debugging, and higher only for a concrete blocker. Review the accepted diff once, batch findings, fix blockers, run affected checks, and stop. Prefer deterministic integration scenarios with real temporary Git repositories; stub remote services at narrow contracts.

Report current slice, proven behavior, blocker, next action, and whether remaining work is trunk, branch, or leaf.
