# Public release checklist

The first release passed [#25](https://github.com/clockgrove/factory-rebuild/issues/25). This checklist now tracks the new immutable artifact required by [#44](https://github.com/clockgrove/factory-rebuild/issues/44) and [#60](https://github.com/clockgrove/factory-rebuild/issues/60) before the Clockgrove pilot. Checking a file into the repository does not satisfy the installed-artifact or live Objective gates.

## Repository and package assets

| Plan §9.6 asset                                | Current preparation                                                                                                   | Release check                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| LICENSE                                        | MIT file present                                                                                                      | Include in published package                                                                                       |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Public policies added                                                                                                 | Review contact routes and supported-version statement at release                                                   |
| Third-party notices                            | Generated from production lock and installed package notices, including SPDX BSD-3-Clause text for `@azu/format-text` | Regenerate for final lock; obtain maintainer review of the publisher's missing copyright notice before publication |
| Project logo                                   | SVG mark in `assets/`                                                                                                 | Review rendering and public use                                                                                    |
| Objective issue form                           | Eight named fields and final pinned-source section in `.github/ISSUE_TEMPLATE/objective.yml`                          | Confirm form renders, submitted body parses, and target owners can copy it                                         |
| Package and marketplace metadata               | Package, manifest, bundled Linux x64 runtime dependencies, and pinned `clockgrove` Git marketplace entry present      | Tag the accepted commit; verify `factory@clockgrove` and an offline CLI install from that public tag               |
| README and CONTRIBUTING                        | Public install and contribution instructions                                                                          | Recheck commands against final CLI                                                                                 |
| CHANGELOG                                      | `0.1.8` changes and release date listed                                                                               | Record exact artifact identity and acceptance evidence in BUILD-STATUS                                             |
| Installed use skills                           | `director` and `setup` packaged                                                                                       | Exercise planning, result decisions, media selection, status, and diagnostics in a fresh target                    |
| CLI                                            | Existing commands documented                                                                                          | Recheck plan/decide/run/decide-result/status/diagnostics/logs against the final CLI                                |
| TypeScript, formatter, test, workflow          | Existing build and deterministic CI                                                                                   | Run credential-free integration gate on merged trunk                                                               |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

1. Confirm accepted #19–#24, #28, #46, #48, and #51 behavior plus the #44/#60 candidate behavior in README, skills, and package tests; obtain review of this release candidate against the final CLI.
2. Follow [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md) to build a versioned tarball from the accepted commit, record its SHA-256 digest, and attach it to a public release at the pinned marketplace tag. Confirm the package contains manifest, CLI, use skills, license, logo, notices, and the exact bundled production dependency tree. Install it with an empty npm cache and compare installed versions with the accepted lock.
3. In a clean environment and fresh third-party repository assembled from the public fixture, install only that public artifact. Use documented commands to plan/inspect, run concurrent lanes and native linear delivery, review/select media, inspect status, and validate the final result.
4. Record package identity and digest, Objective and GitHub issue/PR identities, validated tree, exact final head, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). Do not use a local source path, source-module import, or private instructions.
5. Close #44 and #60 only after this evidence is recorded for the new artifact. Run the separate private adopter smoke in #26 with that same published artifact before claiming trunk acceptance. Do not retag an older release.
