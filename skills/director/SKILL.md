---
name: director
description: Use Factory on a specified target repository to install, inspect, run, check status, cancel, or review media for a development Objective. Never use it on Factory's own repository.
---

# Factory director

Resolve the target repository and Objective from the request. Refuse any Factory source, rebuild, or archive repository as a target. Use the installed Factory CLI for installation, inspection, run, status, and cancel operations; use its media review operation when available. Keep controller scheduling inside Factory rather than reproducing it in chat.

For an install-only request, bind configuration and stop before execution. For a planning request, use `factory plan --objective N --output ABSOLUTE_PRIVATE_FILE`; show its exact pinned source packet, graph, review status, and any specific unresolved question. Do not claim a plan is runnable if review needs a human decision. For run requests, check the Objective and installed authority, then pass the clean candidate with `factory run --objective N --plan FILE`; absent a candidate, explain that run recompiles and independently reviews a fresh graph. If a review question remains, use `factory decide` only after the named operator supplies a specific answer or refusal, actor, and reason. Report the resulting status or explicit refusal and return; do not poll indefinitely. The current trunk supports local dependency graphs, regular PR delivery, native linear stacks, and harness-declared multi-file AssetSets. If an Objective pauses for asset selection, use the installed CLI to list candidates, export a chosen candidate for private review, record the human's whole-set selection, and resume. Respect the target repository's Git LFS rules. Managed-agent and sandbox execution remain unavailable.
