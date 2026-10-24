---
"@aiqadam/platform": patch
---

Bound the cost of a flow's pinned qadams (#879). The API resolves a flow's pins against the registry in one batch instead of filtering the registry once per pin, so `ap_validate_flow` and `ap_flow_structure` no longer scale quadratically with the number of distinct pins; an agent step may hold at most 100 agent tools: a step above that is stored but marked invalid, `ap_validate_flow` reports it under "Agent Tool Limits", and it cannot be published or enabled. A flow already saved above the cap is refused by the worker's provisioning rather than provisioned partially. The worker provisions pins with at most 8 lookups in flight. A pin whose install folder `qadams/<name>@<version>` is past the filesystem's 255-byte path segment — a long package name at a long snapshot version — is now reported as an unavailable pin instead of failing `ON_DISABLE` with a plain `Error`.
