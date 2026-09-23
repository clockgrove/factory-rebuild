# Factory implementation plan

This is the public, controlling build plan for contributors. [BUILD-STATUS.md](BUILD-STATUS.md) names the current slice and next action. The [project board](https://github.com/orgs/clockgrove/projects/2) and linked issues track accepted outcomes. Target repositories own their own product requirements; no private adopter document is required to build or test Factory.

## Product boundary

Factory is a plugin installed for one target GitHub repository. It compiles a human Objective issue into a dependency-linked Work Item graph, runs a configured harness, validates exact changes independently, delivers through GitHub, and validates the integrated Objective. Factory is neither a hosted control plane nor a dependency of the target product. It must never run against a Factory source repository.

The shippable trunk covers installation, compilation, GitHub projection, one active Objective, local DAG scheduling, restart/cancel/retry, exact-tree validation, regular PRs and native linear stacks, media AssetSets, target-owned Git LFS policy, and package/skill/CLI delivery. Later branches add managed cloud-agent execution, a sandbox driver with a bring-your-own harness, and Daytona as its first provider. Automatic bursting, mixed modes, live migration, distributed controllers, provider marketplaces, media-tool discovery, search catalogs, and exhaustive fault systems are leaves and do not block trunk.

## Design laws

1. Keep one vertical path: Objective → validated DAG → GitHub Work Items → ready item → configured driver/harness → exact change or declared AssetSet → independent validation → configured delivery → final Objective validation at the integrated default-branch head. Reviewed media returns to that path.
2. Preserve one source of durable truth per concern: one atomic local continuation snapshot, GitHub Issues/PRs/checks for collaboration, the target Git tree for product result, a content-addressed store for immutable large bytes, and the target repository for requirements and commands. Do not add event logs, receipt ledgers, activation refs, or state reconstruction from session memory.
3. Use narrow contracts for known alternatives: `PlanningModel`, `ExecutionDriver`, `AgentHarness`, `SandboxProvider`, `DeliveryStrategy`, `ContentStore`, and `GitHubGateway`. Keep the runner, scheduler, validator, local state store, Git model, and controller host concrete.
4. Do not create hidden Factory limits beneath GitHub, providers, the OS, target rules, or explicit operator policy. One repository, one execution mode, and one active Objective per installation are explicit trunk boundaries.
5. Stop on invalid compiler output, failed work, or ambiguous external state. Retry starts only by explicit operator action. Ordinary controller restart reattaches to an identifiable active attempt; it is not a retry.
6. Work Items name owned paths, dependencies, resources, acceptance, non-goals, source citations, and command provenance. Parallel items cannot write overlapping paths or claim the same exclusive resource. Validation commands must be observed on the base or literally declared by a supplied source.
7. A worker has no GitHub credentials or publication authority. The controller checks exact bases, PR heads, merge results, and the final default-branch head. Target branch protection and required checks remain authoritative.

## Architecture and state

`src/runner.ts` coordinates the compiler (`src/compiler.ts`), local execution (`src/execution/`), GitHub gateway (`src/github.ts`), and delivery graph runners (`src/delivery/`). The regular and native runners use the same concrete scheduler (`src/scheduler.ts`), validator (`src/validation.ts`), and local content service. `src/state-store.ts` owns the controller lock and one atomic snapshot; `src/state.ts` validates persisted identities before use. `src/contracts.ts` holds the narrow outer contracts. The installed CLI writes private schemaVersion 1 configuration and state outside the target checkout. It reads no archived Factory config or state.

The local driver creates an exact-base worktree, launches an identifiable detached Codex SDK attempt, records its handle, collects an exact change, and removes the owned worktree. Cancellation signals only the owned process group and waits for live members to exit. The regular strategy publishes and merges one PR at a time. The native strategy partitions maximal unbranched chains; forks and multi-parent joins start new units after predecessors integrate. Native stacks use GitHub's versioned stack and asynchronous merge APIs, observe checks and branch protection, and reconcile stable PR/merge identities after restart.

Media belongs to the configured `AgentHarness`: it may return multiple logical multi-file `AssetSet` candidates with evidence and provenance. Candidate count and required LFS roles come from the source-grounded Work Item. The local `ContentStore` keeps immutable SHA-256-addressed bytes and media type; each captured AssetSet descriptor carries its own provenance, rights, visibility, lineage, role bindings, and a digest of the private harness result. This lets the same bytes support different uses without attaching mutable policy to a content digest. Factory supports human review and whole-set selection, binds the selected set to approved destinations, and feeds it through ordinary validation and delivery. The target's `.gitattributes` controls LFS. Factory verifies pointer assignment, exact raw bytes, upload, and fresh-clone hydration.

## Trunk slices and done criteria

| Slice                                      | Public acceptance                                        | Issue                                                        |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| [0](#slice-0--clean-package-and-contracts) | Fresh package and contracts                              | [#1](https://github.com/clockgrove/factory-rebuild/issues/1) |
| [1](#slice-1--installed-walking-skeleton)  | Installed one-item Objective                             | [#2](https://github.com/clockgrove/factory-rebuild/issues/2) |
| [2](#slice-2--local-dag-and-lifecycle)     | Concurrent DAG and ordinary lifecycle                    | [#3](https://github.com/clockgrove/factory-rebuild/issues/3) |
| [3](#slice-3--regular-and-native-delivery) | Predetermined native linear stack                        | [#4](https://github.com/clockgrove/factory-rebuild/issues/4) |
| [4](#slice-4--media-content-and-lfs)       | Multi-file selected asset through LFS                    | [#5](https://github.com/clockgrove/factory-rebuild/issues/5) |
| [5](#slice-5--release-candidate)           | Same installed candidate passes combined disposable gate | [#6](https://github.com/clockgrove/factory-rebuild/issues/6) |

### Slice 0 — Clean package and contracts

Create the public repository, MIT license, plugin manifest, CLI and minimal skills, schemaVersion 1 config/state and seven outer contracts. Reject self-targeting and unsupported execution modes. Accept after clean build, typecheck, lint, format, package inspection, isolated tarball install, and refusal checks. Do not copy archived runtime or tests.

### Slice 1 — Installed walking skeleton

Complete one disposable Objective through one compiled Work Item, GitHub issue, durable snapshot, local Codex SDK attempt, fresh-worktree validation, regular PR merge, and Objective final validation at the exact integrated head. Run the installed package, not source-tree shortcuts.

### Slice 2 — Local DAG and lifecycle

Run dependency-linked items with configured concurrent independent lanes and path/resource serialization. Prove one active Objective, exact predecessor base, cancellation and process-group cleanup, explicit retry, and one controller restart during an active attempt without duplicate work. Use a source-rich public fixture to inspect a read-only draft graph; adopter-specific planning is separate.

### Slice 3 — Regular and native delivery

Partition maximal linear chains; a fork ends a chain and a join starts a new one. Preserve chain-of-one regular behavior. Publish immutable predecessor-based branches and PRs, create the native GitHub stack, verify checks and exact heads, merge via the required asynchronous API, reconcile pending identities after restart, and stop on unexpected external mutation. Accept through the three-layer [public disposable Objective template](../test/fixtures/objectives/native-stack.md). The template length is a scenario size, not a stack-depth limit.

### Slice 4 — Media, content, and LFS

Implement local content-addressed storage, safe source import, multi-file `AssetSet` and produced-set contracts, source/expected-output bindings, authoritative harness evidence, provenance/rights/visibility/lineage, human selection, and exact selected-set materialization. In one disposable Objective, first add a reviewed path-based `.gitattributes` rule, bind a real public fixture image to the harness, return two candidate sets each containing an image and sidecar, select one full set, deliver it through the ordinary Work Item path, and verify every digest after fresh-clone LFS hydration. Do not add image generation providers or a second media orchestrator.

### Slice 5 — Release candidate

Pack the plugin, skills, and CLI. Use the same immutable packaged candidate for one public/self-contained disposable Objective combining concurrent local work, native stack delivery, real harness-declared AssetSets, selection, LFS, and exact final-head validation. Document and test the full install/use flow from a fresh target checkout using only public options and the documented CLI, skill, or MCP/operator surface. A private adopter may then run its own source-grounded pilot under its own repository authority, using that same public artifact and interface exactly as an unrelated third party would. No source-module import, direct state edit, internal hook, unpublished local path, or adopter-specific Factory code path is allowed in that pilot. Its private notes record evidence only; they are not hidden operating instructions. The private pilot is separate evidence and is not required for an unrelated contributor to prove generic Factory behavior.

## Named branches after trunk

- [Managed cloud agent, issue #7](https://github.com/clockgrove/factory-rebuild/issues/7): add a `ManagedAgentExecutionDriver` for the selected GitHub Agent SDK path. Persist provider task identity, observe/cancel/collect, and feed unchanged validation and delivery. Prove the same disposable Objective with this driver.
- [Sandbox plus BYO harness, issue #8](https://github.com/clockgrove/factory-rebuild/issues/8): compose `SandboxExecutionDriver` from `SandboxProvider` and configured `AgentHarness`. Prove transfer, execution, observation, cancellation, collection, and destruction with a provider-neutral fixture.
- [Daytona, issue #9](https://github.com/clockgrove/factory-rebuild/issues/9): add the first concrete `SandboxProvider` and run the Branch 2 scenario unchanged. Keep Daytona details within its adapter.

## Test reset and representative gates

Archived tests, fixtures, snapshots, transcripts, generated evidence, and coverage targets are not copied. Tests are written from current acceptance. Use real temporary Git repositories, commits, worktrees, processes, and files; a scripted harness; and a small stateful GitHub gateway fake at domain operations. Unit tests focus on dense DAG, path/resource, chain, digest, pointer, and descriptor logic. Live SDK/GitHub runs are release-candidate smokes, not a broad qualification system.

`npm ci && npm run build && npm run typecheck && npm run lint && npm run format:check && npm test && npm pack --dry-run` is the local gate. The [Quality workflow](../.github/workflows/quality.yml) runs this gate on pull requests and main without credentials; live GitHub and Codex gates are recorded separately. For GitHub delivery, create a disposable repository you control from [the target fixture](../test/fixtures/disposable-target/), create an Objective using a checked-in template, install the packed tarball in an isolated prefix, and record issue/PR identities, validated tree, and integrated head. Never point Factory at this repository. The [README](../README.md) has the current install command; [BUILD-STATUS.md](BUILD-STATUS.md) identifies the accepted live evidence.

A contributor can copy `test/fixtures/disposable-target/` into an empty directory, run `git init -b main`, commit the two fixture files, and publish that directory as a new disposable GitHub repository they control. Use `gh issue create --body-file` with [walking-skeleton.md](../test/fixtures/objectives/walking-skeleton.md), [local-dag.md](../test/fixtures/objectives/local-dag.md), or [native-stack.md](../test/fixtures/objectives/native-stack.md). Install the packed CLI with a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, bind it to that checkout, and run the Issue number. Do not reuse an Objective after it has merged; use a fresh disposable repository or unique fixture paths for the next gate.

## Archived-source extraction

The archived `clockgrove/factory` commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` is read-only reference. [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) maps each inspected path to reimplemented behavior and clean destination. Copy no archived implementation or test. Before adding a slice, inspect only the named archived files relevant to that slice, record the retained behavior, and leave old protocols and unused helpers behind.

## Release and cutover

The public rebuild repository stays separate until trunk acceptance and the disposable release-candidate gate. Keep the archived source read-only during implementation. Any later repository rename, archival, marketplace change, or adopter activation is a staged operator action after the new trunk is proven; it must not alter the target repository or hide the evidence behind a source-tree-only run. Public issues, PRs, and this plan remain the contributor record.
