---
"@aiqadam/platform": minor
---

A step pinned to a pre-release qadam build (`x.y.z-main.<n>`, the version a build from `main` gives a changed qadam) is now labelled "pre-release build" in the builder step settings, marked on its line and carried as a positive `preReleaseBuild` flag by `ap_flow_structure`, and reported by `ap_validate_flow` as an informational note that never blocks publishing. It is a fact, not a fault: the pin resolves and the step runs exactly the build it names, so it is never surfaced as a warning or an unavailable version. "Update available" pointing at the release and the `follow` hold state remain later slices (ADR-0004, #855).
