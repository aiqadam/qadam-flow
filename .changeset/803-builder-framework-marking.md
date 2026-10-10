---
"@aiqadam/platform": minor
---

Steps pinned to a qadam built for a framework version this release no longer runs are now marked in the flow builder (ADR-0002, #803): a warning icon on the step in the canvas, and a "Framework version no longer supported" notice with the remedy ("update this step") in the step settings. The mark is informational and never blocks editing; no flow is disabled. It is read through a new project-scoped route, `GET /v1/framework-census/flow-version?flowId=…&flowVersionId=…`, reachable by any member of the flow's project with read access; it answers nothing while this release has retired no framework version.
