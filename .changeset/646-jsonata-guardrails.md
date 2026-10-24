---
"@aiqadam/qadam-json": minor
---

"Run JSONata Query" now calls `jsonata(query, { timeout, stack, sequence })` with conservative guardrails (10s / 500 / 1,000,000) instead of none, and adds an optional "Timeout (in seconds)" prop capped at that same 10s ceiling. A query that previously ran unbounded — up to the worker's 600s sandbox kill, most exposed when `query` comes from trigger data an outside sender controls — now fails fast with jsonata's own guardrail error instead. This is a behaviour change on `0.x` (major on full semver, minor here per AGENTS.md): a flow whose query happens to run past 10s, or build a sequence past 1,000,000 entries, will now fail where it previously succeeded, slowly. The stack guardrail counts jsonata's internal per-node evaluation depth, not user recursion levels directly, so a non-tail-recursive expression typically fails around 150-200 levels of recursion, not 500.
