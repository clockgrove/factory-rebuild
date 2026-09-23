# Public release and third-party installation

This is the release procedure for issue [#25](https://github.com/clockgrove/factory-rebuild/issues/25). The first public release is **not yet published**. Keep the tag, marketplace entry, tarball, and evidence tied to the same accepted source commit. Do not run Factory against this repository.

## Distribution shape

The [Clockgrove marketplace](../.agents/plugins/marketplace.json) names the plugin at this repository's root and pins `v0.1.0`. Codex loads its manifest and use skills from that Git tag. The TypeScript CLI is built into a separate npm tarball attached to the matching public GitHub Release; marketplace installation does not build the CLI. Installing that tarball fetches its public runtime dependencies from npm and needs no npm publishing account. The repo marketplace is a public distribution source for people who add it; a listing in the universal Plugins Directory would require a separate submission and review.

The release operator must publish the tag and release asset only after the remaining trunk gates pass. Do not point the marketplace at a moving branch. If the accepted version changes, update the package, manifest, marketplace ref, changelog, and commands here together before tagging.

## Build one candidate

From a clean source checkout at the accepted commit, with Node.js 22 or later, Git, Git LFS, and public npm access, confirm `git status --porcelain` is empty, then run:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run notices:check
npm test
npm pack --pack-destination /absolute/empty/release-directory
cd /absolute/empty/release-directory
sha256sum clockgrove-factory-0.1.0.tgz > SHA256SUMS
```

Inspect the tarball file list for the manifest, installed skills, CLI, license, logo, and notices. Record `git rev-parse HEAD`, package version, tarball SHA-256, and the passing CI run. Create an immutable `v0.1.0` tag at that same commit and attach both `clockgrove-factory-0.1.0.tgz` and `SHA256SUMS` to a public GitHub Release. This procedure does not itself publish or tag anything.

## Install from public artifacts

In a clean environment, after the release exists:

```sh
codex plugin marketplace add clockgrove/factory-rebuild --ref v0.1.0
gh release download v0.1.0 --repo clockgrove/factory-rebuild \
  --pattern clockgrove-factory-0.1.0.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
npm install --prefix /absolute/private/factory-prefix ./clockgrove-factory-0.1.0.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Install and enable `factory@clockgrove` from the Clockgrove source in the Codex Plugins Directory. The installed `director` and `setup` skills guide agent use; the `factory` CLI above supplies their documented operations. The CLI prefix, Factory configuration, state, review exports, and planning candidates must stay outside the target checkout. A target still requires GitHub CLI access and an authenticated Codex SDK environment; media Objectives require Git LFS.

## Fresh disposable Objective

1. Create a new GitHub repository you control from the [public disposable target fixture](../test/fixtures/disposable-target/) and push its initial `main`. Create its Objective issue from the [release candidate Objective](../test/fixtures/objectives/release-candidate.md), with the required media source and target-owned LFS policy. Use a new repository and fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
2. Follow only public instructions and the installed interface. Use `factory install --repository OWNER/REPO --checkout /absolute/target --concurrency 2 --delivery native-stack`; run `factory plan --objective N --output /absolute/private/plan.json`; inspect and resolve any named review question; then run `factory run --objective N --plan /absolute/private/plan.json`.
3. Use `factory status --objective N` and, when requested, `factory review` and `factory select` with the complete chosen AssetSet and explicit `--bind` for each dependent. Resume with `factory run --objective N`. Inspect the final validation result, GitHub issues/PRs, merged default-branch head, and hydrated media bytes.
4. Record the release URL, tag and commit, tarball digest, marketplace source and installed version, target Objective and PR identities, selected AssetSet and LFS evidence, validated tree, exact final head, final commands, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). The target repository may be private, but the public report must omit its sensitive content.

Issue #26 is a separate private adopter smoke using this exact published artifact after the public disposable gate succeeds.

## Open release decisions

The published `@azu/format-text@1.0.2` package declares BSD-3-Clause and names `azu` as author, but its tarball and upstream repository provide no license file. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) records the metadata and source. Resolve the missing package-specific license text and attribution before publication. All other non-optional production packages provide a license file or an explicit publisher licensing statement, and optional Codex platform packages inherit the declared Apache-2.0 family from the installed Codex SDK notice.

An operator must also authorize the public tag and GitHub Release after the implementation gates pass. npm publication is not part of this route and requires no npm publishing credentials.
