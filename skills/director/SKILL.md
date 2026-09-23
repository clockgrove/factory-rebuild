---
name: director
description: Use Factory on a specified target repository to install, inspect, run, check status, cancel, or review media for a development Objective. Never use it on Factory's own repository.
---

# Factory director

Resolve the target repository and Objective from the request. Refuse any Factory source, rebuild, or archive repository as a target. Use the installed Factory CLI for installation, inspection, run, status, and cancel operations; use its media review operation when available. Keep controller scheduling inside Factory rather than reproducing it in chat.

For an install-only request, bind configuration and stop before execution. For run requests, check the Objective and installed authority, then activate the run. Report the resulting status or explicit refusal and return; do not poll indefinitely. The current walking skeleton supports one Work Item and regular delivery; other execution shapes fail preflight.
