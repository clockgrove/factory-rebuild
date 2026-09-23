# Source provenance

The clean implementation starts from the Factory plan reviewed September 22, 2026. The archived source at `clockgrove/factory` commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` is reference material only. No runtime source, test, fixture, snapshot, or generated artifact was copied into the clean implementation.

The MIT license text is retained from the archived repository. Runtime code does not read this ledger.

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
