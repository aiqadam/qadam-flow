---
"@aiqadam/platform": minor
---

`ap_flow_structure` marks a step whose automatic snapshot-follow move was reverted with a `[FOLLOW HELD]` label and returns `followHeld { fromVersion, toVersion, revertedAt }`; `ap_validate_flow` reports the same hold as an informational `follow_hold` note. The hold is read from the existing `GET /v1/qadam-pin-moves/held` data and clears when a person changes the step's version (ADR-0004, #854).
