---
"@aiqadam/platform": minor
---

The `follow` hold state from #854 is now visible in the builder (ADR-0004, #855). When a person reverts a pin move, `follow` holds the step and does not move it again until its version changes; the step settings of a step held for the open flow now show a "held step" label that says so. The label is a fact, not a fault — it is informational and never blocks editing. The hold is read through a new project-scoped route, `GET /v1/qadam-pin-moves/held?flowId=…`, reachable by any member of the flow's project with read access (the platform-admin list/get/revert routes are unchanged).
