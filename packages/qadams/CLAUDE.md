# Qadam SDK

## Quick Start

```bash
npm run create-qadam     # Create qadam
npm run create-action    # Add action
npm run create-trigger   # Add trigger
```

After creating: add path to `tsconfig.base.json`: `"@aiqadam/qadam-{name}": ["packages/qadams/community/{name}/src/index.ts"]`

## Structure

```
packages/qadams/community/{name}/
├── src/index.ts           # createQadam() definition
├── src/lib/auth.ts        # Authentication
├── src/lib/actions/       # One file per action
├── src/lib/trigger/       # One file per trigger
├── src/lib/common/        # API helpers
└── src/i18n/translation.json
```

For a complete example: see `packages/qadams/community/airtable/`.

## Auth Patterns

Three types: `QadamAuth.SecretText()` with validate callback, `QadamAuth.OAuth2()`, `QadamAuth.CustomAuth({ props })`. All support `validate` for credential checking.

## Qadam Context (available in `run()`)

- `context.auth` — resolved credentials
- `context.propsValue` — resolved input properties
- `context.store` — key-value persistence (put/get/delete, persists across executions)
- `context.files` — file upload/download
- `context.connections` — manage OAuth connections
- `context.server` — API access (token, apiUrl, publicUrl)
- `context.run.stop({ response })` — stop flow, return HTTP response
- `context.run.pause({ pauseMetadata })` — pause for delay or webhook callback
- `context.run.respond({ response })` — send response, continue flow
- `context.agent.tools()` — AI agent tool construction
- `context.generateResumeUrl()` — webhook resume URL for paused flows
- `context.executionType` — `BEGIN` or `RESUME`

## Key Rules

- Trigger `run()` must return an **array**
- Use `httpClient` from `@aiqadam/qadams-common` for HTTP requests
- Always provide `sampleData` for triggers
- i18n: `src/i18n/translation.json` with identity-mapped English keys
