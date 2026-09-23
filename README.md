<img src="https://raw.githubusercontent.com/clockgrove/factory-rebuild/main/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

# Factory

Factory turns a repository development Objective into source-grounded Work Items, runs bounded coding attempts, validates their exact result trees, and delivers the changes through GitHub. It is an open-source Clockgrove plugin installed for one target repository at a time.

**Status:** `v0.1.0` release candidate. Trunk issues #19–#24 and #28 have merged; package and public-artifact issue #25 is in final review. The installed local Codex SDK path, dependency DAG, lifecycle, regular pull requests, native linear stacks, human-selected AssetSets, and Git LFS have passed disposable gates using public fixture inputs. The public tag, release asset, fresh third-party Objective, and later adopter smoke remain pending; see [current build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md) for accepted evidence.

## How it works

1. A human writes an Objective as a GitHub Issue in the target repository.
2. Factory previews a pinned-source Work Item graph with owned paths, dependencies, acceptance, non-goals, source citations, and validation commands. One independent source-backed review checks the graph before run.
3. An isolated local Codex attempt works each ready item. Independent lanes may run together; path and named-resource conflicts wait.
4. Factory validates each resulting tree in a fresh worktree, opens GitHub pull requests, integrates them, and validates the complete Objective at the observed default-branch head.

The target repository owns its product and runtime truth. Factory state and credentials stay outside the target checkout. Factory refuses to run against any Factory source repository.

## Install the public release

The `v0.1.0` release candidate has not yet been published. Once its [release page](https://github.com/clockgrove/factory-rebuild/releases/tag/v0.1.0) and independent digest in [build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md) are available, install its plugin and bundled CLI on Linux x64 with Node.js 22 or later:

```sh
codex plugin marketplace add clockgrove/factory-rebuild --ref v0.1.0
gh release download v0.1.0 --repo clockgrove/factory-rebuild \
  --pattern clockgrove-factory-0.1.0.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Compare the tarball digest with the independently recorded build status value.
npm install --offline --ignore-scripts --prefix /absolute/private/factory-prefix \
  ./clockgrove-factory-0.1.0.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Install and enable `factory@clockgrove` from the added Clockgrove source in Codex. The plugin supplies the packaged `director` and `setup` skills; the verified CLI tarball supplies their commands. Both are pinned to the same tag. You need Git, GitHub CLI authentication for the target, and an authenticated Codex SDK environment; media Objectives also require Git LFS. Keep Factory configuration and state outside the target checkout. The [public release procedure](https://github.com/clockgrove/factory-rebuild/blob/main/docs/PUBLIC-RELEASE.md) covers isolated setup and the fresh third-party Objective gate.

## Install a development candidate

The first versioned public artifact is pending the [release checklist](https://github.com/clockgrove/factory-rebuild/blob/main/docs/RELEASE-CHECKLIST.md). The [public release procedure](https://github.com/clockgrove/factory-rebuild/blob/main/docs/PUBLIC-RELEASE.md) describes the pinned Git marketplace, SHA-256-verified CLI tarball, and fresh third-party Objective gate. Until it is published, the following commands exercise a development candidate built from this repository. They do not count as the final third-party installation gate.

Requires Node.js 22 or later, Git, GitHub CLI authentication for the target repository, and an authenticated Codex SDK environment. Media Objectives also require Git LFS. Clone this repository, then build and install its package in an isolated prefix:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm pack
npm install --prefix /tmp/factory-candidate ./clockgrove-factory-0.1.0.tgz
```

Bind one target checkout, inspect a read-only plan, and run that exact candidate with the installed CLI:

```sh
/tmp/factory-candidate/node_modules/.bin/factory install \
  --repository OWNER/REPO \
  --checkout /absolute/path/to/target \
  --concurrency 2
/tmp/factory-candidate/node_modules/.bin/factory plan --objective ISSUE_NUMBER \
  --output /absolute/private/plan.json
/tmp/factory-candidate/node_modules/.bin/factory run --objective ISSUE_NUMBER \
  --plan /absolute/private/plan.json
/tmp/factory-candidate/node_modules/.bin/factory status --objective ISSUE_NUMBER
/tmp/factory-candidate/node_modules/.bin/factory status --objective ISSUE_NUMBER --json
/tmp/factory-candidate/node_modules/.bin/factory diagnostics --objective ISSUE_NUMBER --follow
/tmp/factory-candidate/node_modules/.bin/factory logs --objective ISSUE_NUMBER --item WORK_ITEM_ID --follow
```

An Objective may name additional canonical source paths or a section by exact heading:

```markdown
## Planning sources

- `docs/INDEX.md`
- `docs/WAVE-0.md#Acceptance`
```

Factory reads those bytes from the exact Git base, includes them in the preview with source digests, and ignores dirty checkout edits. Root `AGENTS.md` and `README.md`, when present, are also read from that base. `plan` creates no Work Item issues or run state; its output contains target source text and should stay outside the target checkout. A missing or ambiguous heading stops planning. A sourced graph-review finding allows one revision and re-review. If it remains unresolved, the plan names a specific question; the operator can record an answer with `factory decide --objective ISSUE_NUMBER --plan /absolute/private/plan.json --outcome accept --actor NAME --reason TEXT --answer TEXT --output /absolute/private/decided.json`, or refuse it with `--outcome refuse`. A clean decided plan can be passed to `run --plan`. Running without `--plan` explicitly compiles and reviews a fresh graph. A changed Objective, base, or source packet requires a new plan.
Run `/tmp/factory-candidate/node_modules/.bin/factory help` for the installed command list. Factory stores configuration and state outside the target checkout. Never bind it to a Factory source repository.

`status --json` reports the current step, scheduler eligibility, ready or blocked reason, pending result criterion and question, issue/PR/stack identity, exact base/tree/head, final validation, and last error from Factory's atomic state snapshot. `eligible` means dependencies and resources permit scheduling. `ready` is `false` when blocked and `null` when admission depends on provider capacity, which is not persisted in the snapshot. Configured concurrency exhaustion appears as `blockedReason: "capacity"`. Its provider progress flag reflects whether the current attempt has produced an SDK stream. `diagnostics` prints private newline-delimited JSON events; `--follow` streams new events until interrupted. Validation stdout/stderr is emitted while the command runs, including partial lines, followed by exit evidence; split credentials are buffered until they can be redacted. `logs --item` reads the current attempt's worker stdout/stderr, with the same follow option, and reports when no worker output exists. The timeline correlates repository, Objective, run, item, attempt, and operation where known. It includes planning, scheduling, worker lifecycle and SDK progress, validation command output, result review and pending decisions, GitHub delivery, media review/selection, and finalization. SDK usage and tool identity appear only when the SDK reports them; unavailable model identity or progress is never inferred from response text. Treat diagnostic output as sensitive: it may include worker command output and validation stdout/stderr. Factory redacts known credential patterns and configured allowed secret values, but arbitrary target commands may print other private data. Keep terminal capture and any export outside the target checkout.

Diagnostic and worker progress files live under the private Factory state root with mode `0600`; containing directories are private. The local log is observational and is never used to reconstruct or retry work. A write failure appears on controller stderr and does not alter execution. Operators may delete old `diagnostics.ndjson` and `harness/*.progress.ndjson` files after runs have stopped, subject to their own retention policy. The event `metadata` field holds identities suitable for a future exporter; `detail` is local-only and must not be exported without explicit redaction policy. No hosted telemetry backend is required.

The preview lists each Work Item command and every final Objective command with its exact source and host execution status. A source-declared command must appear as a complete line in its cited pinned source. A base-observed command must name a tracked file at the accepted base containing that exact line, or a matching `package.json` script invocation. A blocked command stops activation; editing a plan file cannot grant authority. At runtime Factory runs admitted commands on the exact result tree. For root `npm test`, `npm run NAME`, `pnpm test`, `pnpm check`, and `pnpm run NAME`, Factory checks the selected script, its pre/post hooks, and package-manager configuration against the accepted base before shell execution. Metadata, dependency, and unrelated script edits may proceed. Nested package-manager wrappers stop for separate authority. A fresh validation worktree may run the exact source-declared bootstrap `pnpm install --frozen-lockfile --ignore-scripts` before its pnpm checks, using a tracked lockfile and no pnpmfile hooks; plain install remains blocked. This pins the package-script entrypoints; source-declared validation can still run candidate code on the local host under the target operator's authority, and Factory does not sandbox that code. Factory then independently checks each stated Work Item and Objective acceptance criterion against the pinned sources, command evidence, and an exact-tree change packet with a conservative 48,000-byte text excerpt budget, explicit truncation markers, and blob descriptors for opaque files. Operators using a reviewer with a larger context can set `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` to a positive byte budget. A truncated text excerpt cannot auto-pass a criterion even if the reviewer returns pass; the criterion waits for an exact-tree operator decision or a retry with a larger text budget and reviewer context. Reviewer failures also wait with their specific error. A source-backed clean result review passes without routine operator approval. Missing, conflicting, or human-owned evidence pauses on one specific criterion. `factory status --objective ISSUE_NUMBER` shows its question and tree. To answer, run `factory decide-result --objective ISSUE_NUMBER [--item WORK_ITEM_ID] --tree EXACT_TREE_SHA --outcome accept|refuse --actor NAME --reason TEXT`, then `factory run --objective ISSUE_NUMBER`. Omit `--item` for final Objective acceptance. The recorded decision is valid only for that criterion and tree; a refusal stops delivery. This decision approves the result criterion, while the target repository's branch protection and GitHub checks still govern PR integration.

Use `--delivery native-stack` at install time to deliver maximal linear chains through GitHub's native stacked pull requests. The default is regular PR delivery.

The historical `clockgrove/objective-fixture` target is private, so its linked Issues and PRs are available only to maintainers. To reproduce the combined release gate without any Clockgrove private material, start with [the public target fixture](https://github.com/clockgrove/factory-rebuild/tree/main/test/fixtures/disposable-target/) in a new GitHub repository you control. Copy its files into an empty directory, initialize and push `main`, then create a GitHub issue from [the release-candidate Objective template](https://github.com/clockgrove/factory-rebuild/blob/main/test/fixtures/objectives/release-candidate.md). Install this package with `--delivery native-stack --concurrency 2` and that target checkout, then run the new issue number. Use a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for an isolated installation. The Objective owns its requirements; Factory derives the Work Item graph and validation commands from the issue and target checkout.

For a media Work Item, the harness returns complete candidate AssetSets and Factory stops for human review. `factory status --objective ISSUE_NUMBER` lists their IDs and digests. Export a candidate outside the target checkout, inspect its image and sidecar, then select the whole set and resume:

```sh
factory review --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --set CANDIDATE_ID --output /absolute/new/review-directory
factory select --objective ISSUE_NUMBER --item WORK_ITEM_ID --set CANDIDATE_ID \
  --reason "Reviewed complete set" --bind DEPENDENT_WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

`select` records the current OS user (or `--actor NAME`), decision time, optional reason, selected destinations and digests, and each explicitly bound direct dependent (`--bind` may be repeated). A bound dependent receives only the selected set's immutable member files and descriptors in a temporary input area. Factory verifies they were not changed and removes them before delivery. The harness may report its representation of those inputs; Factory does not assert that every model call receives raw bytes. Unselected candidates are never passed to the dependent attempt.

The target owns its `.gitattributes` policy. Factory checks selected bytes against the committed LFS pointer and a fresh clone after merge. Source bindings are structured records with `path`, `role`, `mediaType`, `visibility`, and optional `kind`. `kind: repository` (the default) names a file in the pinned target checkout. `kind: local` names an absolute private file explicitly cited in the Objective; Factory imports its bytes into the private content store. `kind: github-attachment` names a GitHub Objective attachment URL explicitly present in the issue body, in either `github.com/user-attachments/assets/UUID` or `github.com/OWNER/REPO/assets/ID/NAME` form. Factory downloads it with the GitHub CLI identity, allows redirects only to GitHub content hosts, and retains the URL, declared authorization/visibility, and immutable digest. A private source is supplied to the harness as a temporary file plus descriptor and is removed before delivery. GitHub attachment availability still depends on that identity's access to the Objective. Media contracts preserve output roles, lineage, and optional tool-supplied format metadata without interpreting the format. The [public PNG fixture](https://github.com/clockgrove/factory-rebuild/blob/main/test/fixtures/objectives/media-lfs.md) shows one source, role, and validation example; an integration test covers an opaque multi-file set consumed downstream under target-owned LFS. If you use a temporary `XDG_CONFIG_HOME` for Factory, keep the controller's GitHub CLI authentication visible through `GH_CONFIG_DIR` or its normal configuration path.

`factory cancel --objective ISSUE_NUMBER` stops owned local processes. `factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID` starts a new explicit attempt for a failed or cancelled unpublished item. Managed-agent and sandbox modes are reserved contract shapes and fail preflight until their branches ship.

Before publication, Factory checks only a Work Item's changed paths against its ownership, rejects newly introduced unsafe links and special files, and runs the packaged Secretlint recommended rules on changed staged content and working bytes (including LFS inputs). A positive result stops publication and reports the rule and path without the value. Review a suspected false positive outside the worker checkout; an operator can set `FACTORY_SECRETLINT_CONFIG` to an absolute, reviewed Secretlint configuration file outside the target checkout, then explicitly retry the failed item. The default recommended rules apply when no override is set. The worker receives only basic ambient variables and secret names explicitly listed in `policy.allowedSecretNames`; GitHub, Git, and SSH credential variables stay excluded even if listed. A local worktree and filtered worker environment do not isolate hostile code from files readable by the operator's OS user.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` (or `~/.config/clockgrove-factory`); durable run state lives under `$XDG_STATE_HOME/clockgrove-factory` (or `~/.local/state/clockgrove-factory`). Do not put either in the target repository.

## Deterministic contributor gate

Run the complete credential-free gate with one command:

```sh
npm test
```

In addition to the focused DAG, delivery-plan, state-ingress, content, media, and transplant tests, this runs bounded application-path scenarios against real temporary Git repositories. A scripted planning model and harness enter through the same composition boundary as the production Codex adapters, while a small stateful GitHub-domain fake records stable Issue, pull-request, and native-stack identities and integrates real commits through a local bare remote. The scenarios prove concurrent regular DAG execution and final-head validation, restart reattachment/cancel/explicit retry, a native linear stack beside an independently replayed and revalidated lane, whole-set media selection, target-owned Git LFS policy, and exact hydrated bytes.

The same gate packs the current working tree, installs the tarball into an isolated prefix with isolated configuration and state, and exercises the public `install`, `status`, and application `planObjective` operations. Live Codex/GitHub disposable Objectives remain separate release evidence; deterministic CI does not replace them. The [release checklist](https://github.com/clockgrove/factory-rebuild/blob/main/docs/RELEASE-CHECKLIST.md) tracks the exact public artifact and fresh third-party run required for #25.

## Project and provenance

The [Factory Rebuild project](https://github.com/orgs/clockgrove/projects/2) tracks one acceptance issue per trunk slice and later capability branches. [The implementation plan](https://github.com/clockgrove/factory-rebuild/blob/main/docs/IMPLEMENTATION-PLAN.md), [current build status](https://github.com/clockgrove/factory-rebuild/blob/main/docs/BUILD-STATUS.md), and [source provenance](https://github.com/clockgrove/factory-rebuild/blob/main/docs/SOURCE-PROVENANCE.md) provide the complete public contributor handoff. The archived source is reference material; this repository is a clean implementation. Generic acceptance uses [public disposable fixtures](https://github.com/clockgrove/factory-rebuild/tree/main/test/fixtures/disposable-target/) and requires no private adopter documents.

Contributions are welcome through focused issues and pull requests. See [CONTRIBUTING.md](https://github.com/clockgrove/factory-rebuild/blob/main/CONTRIBUTING.md), [GOVERNANCE.md](https://github.com/clockgrove/factory-rebuild/blob/main/GOVERNANCE.md), and [SUPPORT.md](https://github.com/clockgrove/factory-rebuild/blob/main/SUPPORT.md). Security concerns have a [private reporting route](https://github.com/clockgrove/factory-rebuild/blob/main/SECURITY.md). Releases are recorded in [CHANGELOG.md](https://github.com/clockgrove/factory-rebuild/blob/main/CHANGELOG.md). Licensed under [MIT](https://github.com/clockgrove/factory-rebuild/blob/main/LICENSE); production dependency licenses are listed in [THIRD_PARTY_NOTICES.md](https://github.com/clockgrove/factory-rebuild/blob/main/THIRD_PARTY_NOTICES.md).
