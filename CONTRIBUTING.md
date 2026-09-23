# Contributing to Factory

Start with an issue in this repository and keep each pull request tied to an observable Factory behavior. The [public project](https://github.com/orgs/clockgrove/projects/2) shows the current trunk order; later capability branches follow trunk acceptance.

## Local checks

Use Node.js 22 or later. From a clean checkout:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm pack --dry-run
```

For behavior that touches GitHub delivery, process lifecycle, or binary content, also test an installed package against a disposable target repository and record the Objective, PR, exact integrated head, and validation result in the pull request.

## Boundaries

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Do not make Factory source repositories execution targets.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Keep archived code as reference only. Record reimplemented behavior in [the provenance ledger](docs/SOURCE-PROVENANCE.md); do not copy archived runtime files or tests.
- Keep product/runtime decisions in their target repositories. Factory is the delivery capability.

This project uses the [MIT license](LICENSE).
