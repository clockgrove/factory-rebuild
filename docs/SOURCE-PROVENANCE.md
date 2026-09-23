# Source provenance

The clean implementation starts from the Factory plan reviewed September 22, 2026. The archived source at `clockgrove/factory` commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` is reference material only. No runtime source, test, fixture, snapshot, or generated artifact was copied into the clean implementation.

The MIT license text is retained from the archived repository. Runtime code does not read this ledger.

## Trunk issue #24 — changed-file safety

Inspected the archived `docs/THREAT-MODEL.md`, `src/runtime/pinned-git-environment.ts`, and `src/execution/artifacts.ts` at commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8`. The clean local driver retains exact-base collection, pinned Git environment, changed-path ownership, and the trusted-local worker boundary. It checks staged candidate modes and traversal, rejects newly introduced special entries, scans only changed staged and working bytes with maintained Secretlint rules, and filters the worker's effective environment to a small ambient allowlist. The archived artifact protocol, blanket file-size/count limits, receipt machinery, and claim of hostile-code containment were not retained. A reviewed operator-owned Secretlint config outside the target checkout is the explicit false-positive path.

## Slice 1 extraction

Audited commit for every row: `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8`. Each destination was reimplemented after inspection behind the clean contracts; no archived source file, protocol, helper, or test was copied.

| Archived path                           | Clean destination                          | Behavior retained                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/local-worktree.ts`         | `src/execution/local.ts`                   | Verify the exact base commit, create an isolated worktree, collect changed paths, and remove an owned worktree. Old artifact patch and LFS transfer machinery was not retained.                                                                                       |
| `src/runtime/pinned-git-environment.ts` | `src/process.ts`                           | Clear inherited `GIT_*` overrides and pin local Git configuration for exact-tree operations. Controller publication remains separately authenticated.                                                                                                                 |
| `src/backends/codex-sdk-local.ts`       | `src/execution/local.ts`                   | Bind the SDK thread to the worker worktree, use workspace-write and no approval prompts, carry abort and authoritative thread result, and keep GitHub credentials out of the worker environment. Old scope, quota, deadline, and recovery machinery was not retained. |
| `src/validation/clean-run.ts`           | `src/validation.ts`                        | Validate in a fresh worktree, compare the exact tree, and run the admitted commands in order. Old toolchain provisioning and qualification machinery was not retained.                                                                                                |
| `src/validation/evidence.ts`            | `src/validation.ts`                        | Tie command evidence to the validated tree. The old digest envelope and protocol fields were not retained.                                                                                                                                                            |
| `src/github.ts`                         | `src/github.ts`, `src/delivery/regular.ts` | Reimplement the issue, PR, check observation, and exact-head merge operations needed for one regular PR. Native stack operations remain Slice 3.                                                                                                                      |
| `src/runtime/process-group.ts`          | `src/execution/local.ts`                   | Retain the worker environment sanitization principle. Process-group cancellation and verified cleanup follow in Slice 2.                                                                                                                                              |
| `src/graph-analysis.ts`                 | `src/compiler.ts`                          | Inspect dependency and scope validation; DAG order and conflict logic follow in Slice 2.                                                                                                                                                                              |

## Slice 2 extraction

The same archived commit was inspected for these behaviors. The clean destinations use the Slice 0 contracts and a new implementation; no archived source or tests were copied.

| Archived path                     | Clean destination                                   | Behavior retained                                                                                                              |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/graph-analysis.ts`           | `src/scheduler.ts`                                  | Validate a dependency DAG, produce stable dependency order, admit ready items, and serialize path or named-resource conflicts. |
| `src/graph.ts`, `src/github.ts`   | `src/github.ts`                                     | Project linked Work Item issues and native blocked-by dependencies alongside the Objective.                                    |
| `src/runtime/process-group.ts`    | `src/process.ts`, `src/execution/local.ts`          | Bind a detached worker to a Linux PID and start time, signal only the owned group, and verify that live group members exit.    |
| `src/backends/codex-sdk-local.ts` | `src/execution/worker.ts`, `src/execution/local.ts` | Run one SDK attempt in an identifiable worker process and collect its durable result after controller restart.                 |

## Slice 3 extraction

The same audited commit supplied the delivery checklist. GitHub's current versioned stack and asynchronous merge API was also checked against official documentation before implementation. The clean delivery code retains only the behavior needed by regular and immutable native linear PR paths.

| Archived path                      | Clean destination                                          | Behavior retained                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/publication/delivery.ts`      | `src/delivery/plan.ts`                                     | Partition maximal unbranched linear chains; end a chain at forks and start a new one at multi-parent joins. No archived delivery-hint protocol was copied.                                     |
| `src/publication/publisher.ts`     | `src/delivery/regular.ts`, `src/delivery/native-runner.ts` | Push deterministic branches, open predecessor-based PRs, and check exact publication heads.                                                                                                    |
| `src/publication/github-stacks.ts` | `src/delivery/native-stack.ts`                             | Use the versioned GitHub native-stack create/read API and asynchronous merge result; reconcile stack identity and wait for merged PR evidence.                                                 |
| `src/publication/stack-manager.ts` | `src/delivery/native-runner.ts`                            | Persist stack and pending merge identity, stop on external head/topology mutation, and verify the integrated default-branch result. The archived receipt and lease machinery was not retained. |

## Slice 4 extraction

The same audited commit supplied the media and LFS checklist. The clean implementation uses one local content-addressed store, one harness-declared AssetSet result, and the existing Work Item delivery path. No archived media orchestrator, receipt protocol, or test was copied.

Trunk gap #23 extends that clean media path with structured-only source bindings, authorized local and recognized Objective attachment ingress, durable selection decisions, and explicit downstream bindings. The new work stays in the same content store, local driver, and ordinary validation/delivery path. It adds no media producer, catalog, or second orchestrator; model/tool/request/parameter details are retained only if a harness or authoritative tool supplies them.

| Archived path                                                             | Clean destination                                | Behavior retained                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/assets/import.ts`, `src/assets/materialize.ts`                       | `src/content/local.ts`, `src/media.ts`           | Import source and produced bytes from regular files, reject redirected paths, preserve SHA-256 identity, and materialize only a selected complete set.                                                                                                   |
| `src/media/contracts.ts`, `src/media/review.ts`                           | `src/contracts.ts`, `src/media.ts`, `src/cli.ts` | Keep multi-file candidate roles, provenance, rights, visibility, lineage, explicit human review and whole-set selection. The configured Codex harness produces candidates; Factory does not select a media provider.                                     |
| `src/repository-profiles/git-lfs.ts`, `src/publication/git-lfs-output.ts` | `src/media.ts`, `src/delivery/regular.ts`        | Follow the target's `.gitattributes`, check required role assignment and exact pointer identity, upload before publication, and verify hydrated bytes from a fresh clone. Old content-transfer receipts and implicit file-size limits were not retained. |

## Deterministic integration suite

The application integration tests were written from the current public acceptance criteria and controlling contracts. No archived test, fixture, helper, snapshot, transcript, or qualification protocol was inspected or copied for them. They use current public target inputs, temporary Git repositories and worktrees, a scripted planning/harness adapter, and a small domain-level GitHub fake.

## GitHub projection and completion hardening

Issue #22 reuses the existing clean GitHub projection and delivery code named above. No additional archived path, state format, test, or recovery protocol was consulted or copied. The completion changes follow the public issue acceptance: marker-based Work Item reconciliation, dependency checks, PR identity verification, and replayable issue/comment closure in the one atomic snapshot. New interruption tests use the current stateful GitHub fake at the application boundary.

## Native dependency waves and retry

Issue #21 extends the clean `src/delivery/native-runner.ts` using the existing `src/scheduler.ts` conflict rule and `src/delivery/plan.ts` unit partition. No additional archived source or test was consulted or copied. New application tests use the current disposable Git target and stateful GitHub fake to prove a post-foundation readiness wave and explicit retry after a terminal native failure.

## Pinned planning and graph review gap (#19)

The audited archive commit's `src/application/plan.ts`, `src/application/compiler-preflight.ts`, and `src/compiler/judge-context.ts` were inspected for the read-only planning boundary, pinned Git authority, and complete independent review packet. The clean `src/compiler.ts`, `src/runner.ts`, and `src/cli.ts` implement only the required current path: exact named sources/headings from the pinned base, a zero-run-state preview, one independent source-backed graph review, at most one automatic revision, and a specific recorded human fallback. The archived policy matrix, repository inventory caps, compiler judge byte cap, obligation inventory, and recovery protocols were not copied.

## Command trust and result acceptance (#20)

The clean implementation extends `src/compiler.ts`, `src/validation.ts`, and the existing regular/native runners from the public #20 acceptance and current #19 planning contract. No additional archived source, test, state format, or validator protocol was inspected or copied. Command authority is checked against pinned source lines or a named tracked base file. Result review uses one bounded exact-tree packet and one specific human fallback, with decisions in the existing atomic snapshot. There is no judge loop or secondary validation ledger.
