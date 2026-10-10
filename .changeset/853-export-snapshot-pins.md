---
"@aiqadam/platform": minor
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

A flow export rewrites a pre-release (`x.y.z-main.<n>`) qadam pin to the newest compatible release, or to `^<base>` with the step listed as exported-unresolved when none passes the props check; the importer marks such a step "update this step" (ADR-0004, #853). `GET /v1/flows/:id/template` takes `sameInstance` (templates that stay on the instance keep their pins) and `keepSnapshots` (an explicit opt-in that keeps the pins and embeds each snapshot's `metadata.json`), in the UI export menu and in `ap_export_flow`. Instances running release images have no pre-release pins, so an export there is unchanged. What a qadam reaches through the framework changes only additively: `PopulatedFlow`, which the framework re-exports, gains optional `exportedUnresolvedPin` on a step's settings; none of the new exports is re-exported.
