# Changelog

This file records public releases of Factory. See [BUILD-STATUS.md](docs/BUILD-STATUS.md) for development acceptance evidence.

## Unreleased

- Default planner and reviewer execution to `gpt-5.6-sol` with medium reasoning, and Work Item execution to `gpt-5.6-luna` with medium reasoning, while preserving independent explicit overrides for every role.
- Stream provider-neutral diagnostics for compile and review model invocations, preserving explicit model policy, provider progress, supplied token/cache usage, safe request/response digests, and parse or semantic rejection reasons.
- Add `factory diagnostics --summary` with per-Objective, phase, and invocation-scope counts, explicit unavailable usage, available token totals, and cache-read numerator/denominator.
- Constrain graph-review finding sources to the exact supplied path enum so heading-qualified aliases cannot produce invalid independent-review evidence.
- Reject every malformed graph-review finding with its exact field path and bounded reason while preserving clean `{"findings":[]}` as the unambiguous no-defect result; private diagnostics never copy provider quotes or unknown source labels.

## 0.1.10 — 2026-09-24

- Ground final Objective acceptance in bounded, supervisor-generated per-Work-Item Git deltas tied to exact result and integration identities.
- Exclude nested Work Item reviewer prose from final review while preserving canonical command receipts, selected-asset facts, and exact source quotations.
- Fail closed on truncated or identity-inconsistent evidence and preserve every rejected final-review candidate with its field-level rejection reason.

## 0.1.9 — 2026-09-24

- Bind every ordered validation-command receipt to its exact result tree, stable index, and successful exit code for Work Item and final Objective review.
- Name result and integrated commit/tree identities separately in reviewer observations, and explicitly teach the reviewer that Git commits and trees are different object types.
- Move durable run state to schemaVersion 2 and reject missing, misordered, cross-tree, or command-substituted receipts before resumed state can be trusted.

## 0.1.8 — 2026-09-23

- Review the complete proposed plan, including command-authority receipts and exact final integrated-head commands, rather than only the inner Work Item graph.
- Bind the canonical plan packet, independent review result, and installation configuration to schemaVersion 2 planning candidates and exact-digest human decisions.
- Activate an unchanged accepted preview with deterministic verification and no second planning-review model call; reject stale, configuration-drifted, or review-tampered candidates before GitHub projection.

## 0.1.7 — 2026-09-23

- Persist explicit, independently selectable Codex model and reasoning choices for planning, review, and Work Item execution instead of inheriting ambient user configuration.
- Supply result review with the accepted graph's owned paths and named resources for each relevant attempt, so disjoint scheduling criteria can be proved from bounded authoritative observations.
- Add installed-package, adapter-routing, configuration-validation, and exact resource-observation regressions for the v0.1.6 public-gate failures.

## 0.1.6 — 2026-09-23

- Supply Work Item review with each relevant attempt's validated result head so a native successor can prove its exact predecessor base before the stack is integrated.
- Add bounded runner-derived delivery context: regular delivery, or native unit identity, one-based layer number/count, and immediate predecessor item.
- Add focused observation coverage and a three-layer temporary-Git regression that proves the second and third native layers without result decisions.

## 0.1.5 — 2026-09-23

- Persist the immutable worker execution base and integration head observed at attempt start; native replay advances only the mutable validation and delivery base.
- Label legacy missing start provenance explicitly in Work Item review observations instead of inferring it from later delivery state.
- Add a focused replay-versus-attempt unit regression and a staggered native temporary-Git scenario in which one concurrent root integrates before its peer is reviewed.

## 0.1.4 — 2026-09-23

- Supply Work Item result review with a bounded scheduling-provenance packet derived from the authoritative atomic snapshot and accepted graph.
- Ground exact attempt, start-time, execution-base, dependency, peer-start, and integration-state findings in `Delivery observations`, while preserving criterion-specific human fallback for missing or contradictory evidence.
- Add temporary-Git concurrent-root and negative provenance regressions, plus persisted attempt start-time validation.

## 0.1.3 — 2026-09-23

- Turn an invalid independent graph-review response into an explicit planning decision on the pinned graph, never a clean automated pass.
- Let a recorded human acceptance of that exact graph proceed without repeating the malformed review; refusal still stops activation.
- Add temporary-Git planning and application regressions for the paused and accepted paths.

## 0.1.2 — 2026-09-23

- Keep result-review findings independent per acceptance criterion, so one malformed citation cannot erase separate valid proofs.
- Accept only exact quotes from pinned source, the supplied Git change packet, exact-tree command-pass evidence, or delivery observations. Retain human fallback for missing evidence and truncated result text.
- Add temporary-Git regressions for evidence-backed automatic passes and an unsupported finding that pauses only its own criterion.

## 0.1.1 — 2026-09-23

- Allow an Objective to create a pnpm workspace and run its exactly source-declared bootstrap, check, and test commands at the validated result tree.
- Keep pre-existing scripts pinned to the Objective base, pin newly established scripts to later Work Item predecessors, and reject new lifecycle hooks or nested package-manager wrappers.
- Backfill the `v0.1.0` exact-public-artifact acceptance record and require a new installed-artifact gate before the Clockgrove pilot.

## 0.1.0 — 2026-09-23

- Compile pinned repository Objectives into reviewed Work Item DAGs with independently admitted validation commands and exact-tree acceptance decisions.
- Run local Codex SDK attempts through concurrent regular pull requests or native linear stacks, with restart, cancellation, explicit retry, and verified GitHub closure.
- Preserve human-selected media AssetSets, structured source bindings, target-owned Git LFS policy, and changed-file safety checks before publication.
- Expose private agent-readable status, diagnostics, and worker output without using logs as lifecycle authority.
- Add the public Clockgrove Git marketplace, bundled Linux x64 CLI tarball, packaged use skills, community policies, and third-party license notices.
