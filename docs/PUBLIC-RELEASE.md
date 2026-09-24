# Public release and third-party installation

This is the release and installation procedure for the current candidate. [#25](https://github.com/clockgrove/factory-rebuild/issues/25) accepted `v0.1.0`; [#44](https://github.com/clockgrove/factory-rebuild/issues/44), [#46](https://github.com/clockgrove/factory-rebuild/issues/46), [#48](https://github.com/clockgrove/factory-rebuild/issues/48), and [#51](https://github.com/clockgrove/factory-rebuild/issues/51) are open pre-pilot gates. Keep the tag, marketplace entry, tarball, and evidence tied to the same source commit. The [build status](BUILD-STATUS.md) distinguishes publication from installed Objective acceptance. Do not run Factory against this repository.

## Distribution shape

The [Clockgrove marketplace](../.agents/plugins/marketplace.json) names the plugin at this repository's root and pins `v0.1.4`. Codex loads its manifest and use skills from that Git tag. The TypeScript CLI and its production dependency tree are built into a separate npm tarball attached to the matching public GitHub Release; marketplace installation does not build the CLI. The bundled tree makes the release install independent of later npm dependency resolution and needs no npm publishing account. The first tarball targets Linux x64 with Node.js 22 or later. The repo marketplace is a public distribution source for people who add it; a listing in the universal Plugins Directory would require a separate submission and review.

Publish a candidate tag and release asset only after its code, CI, packaging, and notice checks pass; then run the disposable gate from a fresh public download. Publication is not acceptance and does not authorize the Clockgrove pilot. Do not point the marketplace at a moving branch. If the candidate version changes, update the package, manifest, marketplace ref, changelog, README status, and commands here together before tagging.

## Build one candidate

From a clean Linux x64 source checkout at the accepted commit, with Node.js 22 or later, Git, Git LFS, and public npm access, confirm `git status --porcelain` is empty. Choose an empty absolute release directory outside the checkout, then run:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run notices:check
npm test
mkdir -p /absolute/empty/release-directory
npm pack --pack-destination /absolute/empty/release-directory
cd /absolute/empty/release-directory
sha256sum clockgrove-factory-0.1.4.tgz > SHA256SUMS
```

Inspect the tarball file list for the manifest, installed skills, CLI, license, logo, notices, and bundled production dependency tree. In a separate empty prefix, install the tarball with `npm install --offline --ignore-scripts --prefix /absolute/private/check-prefix ./clockgrove-factory-0.1.4.tgz` using an empty npm cache; verify `factory help`, compare every installed bundled package version with `package-lock.json`, and check that notices cover the same tree. Record `git rev-parse HEAD`, package version, tarball SHA-256, and the passing CI run. Create a protected `v0.1.4` tag at that same commit and attach both `clockgrove-factory-0.1.4.tgz` and `SHA256SUMS` to a public GitHub Release. Record the expected SHA-256 outside the mutable Release assets, in [BUILD-STATUS.md](BUILD-STATUS.md). This procedure does not itself publish or tag anything.

## Install from public artifacts

In a clean Linux x64 environment with Node.js 22 or later, after the release exists, set aside fresh Factory roots outside the target checkout while keeping GitHub CLI authentication reachable:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
FACTORY_TRIAL_ROOT=$(mktemp -d)
export XDG_CONFIG_HOME="$FACTORY_TRIAL_ROOT/config"
export XDG_STATE_HOME="$FACTORY_TRIAL_ROOT/state"
gh auth status
```

Then install from the public tag and release assets:

```sh
codex plugin marketplace add clockgrove/factory-rebuild --ref v0.1.4
codex plugin add factory@clockgrove
gh release download v0.1.4 --repo clockgrove/factory-rebuild \
  --pattern clockgrove-factory-0.1.4.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
# Also compare the digest with the independently recorded release value in BUILD-STATUS.md.
npm install --offline --ignore-scripts --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.4.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Verify `factory@clockgrove` appears in `codex plugin list --json` before the live Objective. The installed `director` and `setup` skills guide agent use; the `factory` CLI above supplies their documented operations. The CLI prefix, Factory configuration, state, review exports, and planning candidates must stay outside the target checkout. A target still requires GitHub CLI access and an authenticated Codex SDK environment; media Objectives require Git LFS.

## Fresh disposable Objective

1. Create a new GitHub repository you control from the [public disposable target fixture](../test/fixtures/disposable-target/) and push its initial `main`. Create its Objective issue from the [release candidate Objective](../test/fixtures/objectives/release-candidate.md), with the required media source and target-owned LFS policy. Use a new repository and fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
2. Follow only public instructions and the installed interface. Use `factory install --repository OWNER/REPO --checkout /absolute/target --concurrency 2 --delivery native-stack`; run `factory plan --objective N --output /absolute/private/plan.json`; inspect the source and host-execution status of every validation command, including any exact source-declared `pnpm install --frozen-lockfile --ignore-scripts` bootstrap; resolve any named review question; then run `factory run --objective N --plan /absolute/private/plan.json`.
3. Use `factory status --objective N` and `factory status --objective N --json` for the current atomic snapshot. Use `factory diagnostics --objective N` for a private timeline and `factory logs --objective N --item ID` for a recorded attempt's worker output; add `--follow` only while observation is needed. These outputs can include private target content and never authorize continuation by themselves. When requested, use `factory review` and `factory select` with the complete chosen AssetSet and explicit `--bind` for each dependent. Resume with `factory run --objective N`. If status pauses on a result criterion, inspect its named evidence and exact tree; a bounded text excerpt or opaque blob descriptor is not a complete large file. A truncated text excerpt requires exact-tree operator decision even if the reviewer reported pass; inspect the full tree or repeat review with a larger `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` and reviewer context. Ask the operator to accept or refuse that criterion, record `factory decide-result --objective N [--item ID] --tree EXACT_TREE_SHA --outcome accept|refuse --actor NAME --reason TEXT`, then resume `factory run --objective N` after acceptance. Include `--item` for a Work Item and omit it for final Objective acceptance. Inspect the final validation result, GitHub issues/PRs, merged default-branch head, and hydrated media bytes.
4. Record the release URL, tag and commit, tarball digest, marketplace source and installed version, target Objective and PR identities, selected AssetSet and LFS evidence, validated tree, exact final head, final commands, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). The target repository may be private, but the public report must omit its sensitive content, worker logs, and diagnostic details.

Issue #26 is a separate private adopter smoke using the new exact published artifact after its public disposable gate succeeds. The `v0.1.0` proof is historical and does not qualify changed code. The published v0.1.2 artifact was blocked at read-only graph review; v0.1.3 reached a human-accepted exact graph but paused at Work Item result review because the review packet omitted authoritative attempt provenance. Those failures remain recorded in [BUILD-STATUS.md](BUILD-STATUS.md); the v0.1.4 candidate must earn its own installed disposable gate.

## Open release decisions

The published [`@azu/format-text@1.0.2` metadata](https://www.npmjs.com/package/@azu/format-text/v/1.0.2) declares BSD-3-Clause and names `azu` as author. Its npm tarball and [exact `gitHead` source tree](https://github.com/azu/format-text/tree/2f72a7bf808c0818a395c2323d77128352539297) provide no license file or copyright holder/year. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) includes the [canonical SPDX BSD-3-Clause terms](https://spdx.org/licenses/BSD-3-Clause.html), preserves the unfilled copyright variables, and records the publisher metadata without inventing attribution. **A maintainer must review this documented upstream omission before release**; the generic text cannot replace a package-specific copyright notice the publisher never supplied. All other non-optional production packages provide a license file or an explicit publisher licensing statement. The optional Codex platform packages declare Apache-2.0; the notices include the Codex SDK's Apache-2.0 text for the same version.

An operator must authorize each public tag and GitHub Release after the code/CI/package gates pass; the installed disposable Objective is the subsequent acceptance gate. npm publication is not part of this route and requires no npm publishing credentials.
