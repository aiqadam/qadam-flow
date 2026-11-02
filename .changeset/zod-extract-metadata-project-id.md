---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

`ExecuteExtractQadamMetadataJobData` accepts a job with no `projectId` key, the shape the worker receives after JSON drops `projectId: undefined`. zod 4.6 stopped treating a missing key as `z.undefined()`, which failed every qadam-metadata job with `INTERNAL_ERROR`. Nothing a qadam reaches through the framework changes.
