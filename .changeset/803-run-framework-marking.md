---
"@aiqadam/platform": minor
---

Steps pinned to a qadam built for a framework version this release no longer runs are now marked in the run view (ADR-0002, #803): the run page already renders the builder's canvas and step settings against the run's own flow version, and its run step detail now carries the same "Framework version no longer supported — update this step" notice. The mark is shown even when the run captured no output for the step (an unsupported step can fail or be skipped); it is informational and no flow is disabled.
