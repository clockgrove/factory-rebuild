# Factory

Factory turns a repository development Objective into source-grounded Work Items, runs bounded coding attempts, validates their exact result trees, and delivers the changes through GitHub. It is an open-source Clockgrove plugin installed for one target repository at a time.

**Status:** active public rebuild. The local Codex SDK path, dependency DAG, ordinary lifecycle, regular pull-request delivery, and native linear stacks have passed installed-package disposable gates. Media, LFS delivery, and the combined disposable release gate are tracked in [the public project](https://github.com/orgs/clockgrove/projects/2). Private adopter pilots follow the public release gate and use the same packaged plugin interface. The current package is a development candidate, not a published release.

## How it works

1. A human writes an Objective as a GitHub Issue in the target repository.
2. Factory compiles a small Work Item graph with owned paths, dependencies, acceptance, non-goals, source citations, and validation commands.
3. An isolated local Codex attempt works each ready item. Independent lanes may run together; path and named-resource conflicts wait.
4. Factory validates each resulting tree in a fresh worktree, opens GitHub pull requests, integrates them, and validates the complete Objective at the observed default-branch head.

The target repository owns its product and runtime truth. Factory state and credentials stay outside the target checkout. Factory refuses to run against any Factory source repository.

## Try the development package

Requires Node.js 22 or later, Git, GitHub CLI authentication for the target repository, and an authenticated Codex SDK environment. Clone this repository, then build and install its package in an isolated prefix:

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

`factory cancel --objective ISSUE_NUMBER` stops owned local processes. `factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID` starts a new explicit attempt for a failed or cancelled unpublished item. Managed-agent and sandbox modes are reserved contract shapes and fail preflight until their branches ship.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` (or `~/.config/clockgrove-factory`); durable run state lives under `$XDG_STATE_HOME/clockgrove-factory` (or `~/.local/state/clockgrove-factory`). Do not put either in the target repository.

## Project and provenance

The [Factory Rebuild project](https://github.com/orgs/clockgrove/projects/2) tracks one acceptance issue per trunk slice and later capability branches. [The implementation plan](docs/IMPLEMENTATION-PLAN.md), [current build status](docs/BUILD-STATUS.md), and [source provenance](docs/SOURCE-PROVENANCE.md) provide the complete public contributor handoff. The archived source is reference material; this repository is a clean implementation. Generic acceptance uses [public disposable fixtures](test/fixtures/disposable-target/) and requires no private adopter documents.

Contributions are welcome through focused issues and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
