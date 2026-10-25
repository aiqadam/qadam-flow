---
"@aiqadam/platform": minor
---

The API now resolves an official qadam pin from the qadam version store, as the engine already did (ADR-0003, #779): a version only the store holds is served to the builder, the framework census and the worker's provisioning from its own `metadata.json`, and `GET /v1/qadams/registry` lists the stored versions. A pin that used to be reported as missing while its code sat in the store now resolves and runs. No image puts versions in the store yet (#807), so a default install is unchanged.
