# First public release checklist

This checklist tracks issue [#25](https://github.com/clockgrove/factory-rebuild/issues/25). Preparation can merge before the trunk interfaces settle. Checking a file into the repository does not satisfy the installed-artifact or live Objective gates.

## Repository and package assets

| Plan §9.6 asset                                | Current preparation                                                                          | Release check                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| LICENSE                                        | MIT file present                                                                             | Include in published package                                                                                  |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Public policies added                                                                        | Review contact routes and supported-version statement at release                                              |
| Third-party notices                            | Generated from production lock and installed package notices                                 | Regenerate for final lock; resolve the missing `@azu/format-text` license-text attribution before publication |
| Project logo                                   | SVG mark in `assets/`                                                                        | Review rendering and public use                                                                               |
| Objective issue form                           | Eight named fields and final pinned-source section in `.github/ISSUE_TEMPLATE/objective.yml` | Confirm form renders, submitted body parses, and target owners can copy it                                    |
| Package and marketplace metadata               | Package, manifest, and pinned `clockgrove` Git marketplace entry present                     | Tag the accepted commit and verify `factory@clockgrove` installation from that public tag                     |
| README and CONTRIBUTING                        | Public install and contribution instructions                                                 | Recheck commands against final CLI                                                                            |
| CHANGELOG                                      | Unreleased section present                                                                   | Add exact version, date, and accepted changes                                                                 |
| Installed use skills                           | `director` and `setup` packaged                                                              | Exercise them with the installed CLI in a fresh target                                                        |
| CLI                                            | Existing commands documented                                                                 | Recheck merged #19 plan/decide/run commands against final CLI                                                 |
| TypeScript, formatter, test, workflow          | Existing build and deterministic CI                                                          | Run credential-free integration gate on merged trunk                                                          |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

1. Merge and accept #19–#24 and #28. Resolve any changed command or safety behavior in README, skills, and package tests.
2. Follow [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md) to build a versioned tarball from the accepted commit, record its SHA-256 digest, and attach it to a public release at the pinned marketplace tag. Confirm the package contains manifest, CLI, use skills, license, logo, and notices.
3. In a clean environment and fresh third-party repository assembled from the public fixture, install only that public artifact. Use documented commands to plan/inspect, run concurrent lanes and native linear delivery, review/select media, inspect status, and validate the final result.
4. Record package identity and digest, Objective and GitHub issue/PR identities, validated tree, exact final head, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). Do not use a local source path, source-module import, or private instructions.
5. Close #25 only after this evidence is recorded. Run the separate private adopter smoke in #26 with the same published artifact before claiming trunk acceptance.
