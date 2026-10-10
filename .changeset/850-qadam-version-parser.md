---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

One version parser decides what a qadam version may look like: a release `x.y.z` or a snapshot `x.y.z-main.<n>`, and no other prerelease (ADR-0004, #850). A step's `qadamVersion` pin, the `release` query of the qadam list and registry, and the qadam alias now use it, and the alias is `name@version` (a legacy `name-version` alias is still read). The custom-qadam install schema keeps `x.y.z`. Nothing a qadam reaches through the framework changed: none of the changed exports is re-exported by it.
