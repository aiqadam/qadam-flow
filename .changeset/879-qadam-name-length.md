---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

Bound a qadam name to npm's 214-character limit in `AddQadamRequestBody`, and move
`NPM_PACKAGE_NAME_MAX_LENGTH` into `shared` next to the name grammar so every schema and path
check uses one number (#879). `shared` also gains `MAX_AGENT_TOOL_PINS` and
`flowQadamUtil.countAgentToolPins`, the agent-step tool cap the API and worker enforce. The worker
already treated a longer name as not found; this keeps one from being stored as a custom qadam.
Nothing a qadam reaches through the framework changed.
