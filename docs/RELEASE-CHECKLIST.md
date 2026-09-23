# First public release checklist

This checklist tracks issue [#25](https://github.com/clockgrove/factory-rebuild/issues/25). Preparation can merge before the trunk interfaces settle. Checking a file into the repository does not satisfy the installed-artifact or live Objective gates.

## Repository and package assets

| Plan §9.6 asset                                | Current preparation                                          | Release check                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| LICENSE                                        | MIT file present                                             | Include in published package                                                                                          |
| CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE | Public policies added                                        | Review contact routes and supported-version statement at release                                                      |
| Third-party notices                            | Regenerated from production dependency lock                  | Regenerate for final lock; include license texts in package                                                           |
| Project logo                                   | SVG mark in `assets/`                                        | Review rendering and public use                                                                                       |
| Objective issue form                           | Eight named fields in `.github/ISSUE_TEMPLATE/objective.yml` | Confirm form renders and target owners can copy it                                                                    |
| Package and marketplace metadata               | Package and plugin manifest present                          | Verify final version, manifest, package files, and create the public marketplace entry against the published artifact |
| README and CONTRIBUTING                        | Public install and contribution instructions                 | Recheck commands against final CLI                                                                                    |
| CHANGELOG                                      | Unreleased section present                                   | Add exact version, date, and accepted changes                                                                         |
| Installed use skills                           | `director` and `setup` packaged                              | Exercise them with the installed CLI in a fresh target                                                                |
| CLI                                            | Existing commands documented                                 | Add and document #19 plan/inspect before release                                                                      |
| TypeScript, formatter, test, workflow          | Existing build and deterministic CI                          | Run credential-free integration gate on merged trunk                                                                  |

No required asset is intentionally omitted. MCP is not a first-release requirement.

## Exact-artifact acceptance

1. Merge and accept #19–#24 and #28. Resolve any changed command or safety behavior in README, skills, and package tests.
2. Cut one immutable public version with a package identity, tarball digest, tag, and public install source. Confirm the package contains manifest, CLI, use skills, license, and notices. Confirm the public marketplace destination and publish its listing for that artifact.
3. In a clean environment and fresh third-party repository assembled from the public fixture, install only that public artifact. Use documented commands to plan/inspect, run concurrent lanes and native linear delivery, review/select media, inspect status, and validate the final result.
4. Record package identity and digest, Objective and GitHub issue/PR identities, validated tree, exact final head, and operator acceptance in [BUILD-STATUS.md](BUILD-STATUS.md). Do not use a local source path, source-module import, or private instructions.
5. Close #25 only after this evidence is recorded. Run the separate private adopter smoke in #26 with the same published artifact before claiming trunk acceptance.
