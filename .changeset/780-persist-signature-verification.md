---
"@aiqadam/platform": patch
---

The signature check on `@aiqadam/*` packages (ADR-0003, #780) no longer repeats its registry reads after every worker restart. It keeps each verified npm signature in a ledger next to the workspace's `bun.lock` and checks it again offline against npm's pinned keys, so a restarted worker needs the registry only for a package it never verified, one whose bytes changed, or a ledger that was lost or edited; those are still refused when the registry is unreachable. The same ledger format (`qadam-signatures.json`) is available beside the qadam version store for the fetch of #806. Only matters with `AP_OFFICIAL_QADAMS_INSTALL_ENABLED` on, which stays off; nothing changes in a default install.
