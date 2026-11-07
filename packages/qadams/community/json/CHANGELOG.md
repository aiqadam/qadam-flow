# @aiqadam/qadam-json

## 0.2.0

### Minor Changes

- 39f031d: "Run JSONata Query" now calls `jsonata(query, { timeout, stack, sequence })` with conservative guardrails (10s / 500 / 1,000,000) instead of none, and adds an optional "Timeout (in seconds)" prop capped at that same 10s ceiling. A query that previously ran unbounded — up to the worker's 600s sandbox kill, most exposed when `query` comes from trigger data an outside sender controls — now fails fast with jsonata's own guardrail error instead. This is a behaviour change on `0.x` (major on full semver, minor here per AGENTS.md): a flow whose query happens to run past 10s, or build a sequence past 1,000,000 entries, will now fail where it previously succeeded, slowly. The stack guardrail counts jsonata's internal per-node evaluation depth, not user recursion levels directly, so a non-tail-recursive expression typically fails around 150-200 levels of recursion, not 500.

### Patch Changes

- Updated dependencies [b40c189]
- Updated dependencies [66d8bad]
- Updated dependencies [14ea41c]
- Updated dependencies [34efa2b]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [e9c6861]
- Updated dependencies [482ecae]
- Updated dependencies [c2fde9a]
- Updated dependencies [18e5850]
- Updated dependencies [89aec70]
- Updated dependencies [9ccf0d2]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
- Updated dependencies [47c9525]
- Updated dependencies [777a794]
  - @aiqadam/qadams-framework@0.37.0
  - @aiqadam/qadams-common@0.17.2
