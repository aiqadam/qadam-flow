---
"@aiqadam/platform": minor
---

A step whose pinned qadam version is unavailable and was not moved to the image's build automatically (ADR-0003, #808) is now marked "version unavailable — update this step" in the builder (the step canvas and the step settings panel), in the run view, and in MCP (`ap_flow_structure`'s `pinStay` field and `⚠️ [VERSION UNAVAILABLE]` label, `ap_validate_flow`'s `version_unavailable` warning). The mark is read from a new project-scoped `GET /v1/qadam-pin-moves/check` endpoint and never blocks editing, publishing or a run — the flow is never disabled over it (#435).
