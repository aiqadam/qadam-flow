`AP_ENVIRONMENT` maps to the `ApEnvironment` enum. Valid values are EXACTLY:

- `prod`  → `ApEnvironment.PRODUCTION`
- `dev`   → `ApEnvironment.DEVELOPMENT`
- `test`  → `ApEnvironment.TESTING`

Set `AP_ENVIRONMENT=test` for the test environment (`.env.tests`). NOT `TESTING`.

**Footgun:** there are two same-named enum members with different string values:
- `ApEnvironment.TESTING === 'test'` (deployment env — what `AP_ENVIRONMENT` uses)
- `RunEnvironment.TESTING === 'TESTING'` (flow-run env — unrelated)

Using `TESTING` for `AP_ENVIRONMENT` is a valid-looking string that silently never equals `'test'`, so every `environment === ApEnvironment.TESTING` branch dies quietly (registry fresh-read, validation short-circuits, etc.). `validateEnvPropsOnStartup` now throws on any `AP_ENVIRONMENT` that isn't a valid `ApEnvironment` value — do not downgrade that to a warning.
