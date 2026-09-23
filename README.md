# Factory

Factory turns a repository development Objective into source-grounded Work Items, runs bounded coding attempts, validates their exact result trees, and delivers the changes through GitHub. It is an open-source Clockgrove plugin installed for one target repository at a time.

**Status:** public release candidate in progress. The installed local Codex SDK path, dependency DAG, lifecycle, regular pull requests, native linear stacks, human-selected AssetSets, and Git LFS have passed public disposable gates. One pinned installed package has now passed the combined public disposable Objective; see [current build status](docs/BUILD-STATUS.md) for the exact artifact and final head. The current package remains a development candidate while the separate trunk-gap review and required public-artifact adopter pilot are pending.

## How it works

1. A human writes an Objective as a GitHub Issue in the target repository.
2. Factory compiles a small Work Item graph with owned paths, dependencies, acceptance, non-goals, source citations, and validation commands.
3. An isolated local Codex attempt works each ready item. Independent lanes may run together; path and named-resource conflicts wait.
4. Factory validates each resulting tree in a fresh worktree, opens GitHub pull requests, integrates them, and validates the complete Objective at the observed default-branch head.

The target repository owns its product and runtime truth. Factory state and credentials stay outside the target checkout. Factory refuses to run against any Factory source repository.

## Try the development package

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

Bind one target checkout and run a GitHub Objective with the installed CLI:

```sh
/tmp/factory-candidate/node_modules/.bin/factory install \
  --repository OWNER/REPO \
  --checkout /absolute/path/to/target \
  --concurrency 2
/tmp/factory-candidate/node_modules/.bin/factory run --objective ISSUE_NUMBER
/tmp/factory-candidate/node_modules/.bin/factory status --objective ISSUE_NUMBER
```

Use `--delivery native-stack` at install time to deliver maximal linear chains through GitHub's native stacked pull requests. The default is regular PR delivery.

To reproduce the combined release gate without any Clockgrove private material, start with [the public target fixture](test/fixtures/disposable-target/) in a new GitHub repository you control. Copy its files into an empty directory, initialize and push `main`, then create a GitHub issue from [the release-candidate Objective template](test/fixtures/objectives/release-candidate.md). Install this package with `--delivery native-stack --concurrency 2` and that target checkout, then run the new issue number. Use a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for an isolated installation. The Objective owns its requirements; Factory derives the Work Item graph and validation commands from the issue and target checkout.

For a media Work Item, the harness returns complete candidate AssetSets and Factory stops for human review. `factory status --objective ISSUE_NUMBER` lists their IDs and digests. Export a candidate outside the target checkout, inspect its image and sidecar, then select the whole set and resume:

```sh
factory review --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --set CANDIDATE_ID --output /absolute/new/review-directory
factory select --objective ISSUE_NUMBER --item WORK_ITEM_ID --set CANDIDATE_ID
factory run --objective ISSUE_NUMBER
```

The target owns its `.gitattributes` policy. Factory checks selected bytes against the committed LFS pointer and a fresh clone after merge. Media contracts use declared source roles, types, and visibility, plus output roles, lineage, and optional tool-supplied format metadata; Factory does not interpret the file format. The [public PNG fixture](test/fixtures/objectives/media-lfs.md) shows one source, role, and validation example, while a local test covers an opaque 3D file and sidecar under target-owned LFS. If you use a temporary `XDG_CONFIG_HOME` for Factory, keep the controller's GitHub CLI authentication visible through `GH_CONFIG_DIR` or its normal configuration path.

`factory cancel --objective ISSUE_NUMBER` stops owned local processes. `factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID` starts a new explicit attempt for a failed or cancelled unpublished item. Managed-agent and sandbox modes are reserved contract shapes and fail preflight until their branches ship.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` (or `~/.config/clockgrove-factory`); durable run state lives under `$XDG_STATE_HOME/clockgrove-factory` (or `~/.local/state/clockgrove-factory`). Do not put either in the target repository.

## Project and provenance

The [Factory Rebuild project](https://github.com/orgs/clockgrove/projects/2) tracks one acceptance issue per trunk slice and later capability branches. [The implementation plan](docs/IMPLEMENTATION-PLAN.md), [current build status](docs/BUILD-STATUS.md), and [source provenance](docs/SOURCE-PROVENANCE.md) provide the complete public contributor handoff. The archived source is reference material; this repository is a clean implementation. Generic acceptance uses [public disposable fixtures](test/fixtures/disposable-target/) and requires no private adopter documents.

Contributions are welcome through focused issues and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
