import path from 'path'
import dotenv from 'dotenv'

const resolvedPath = path.resolve(__dirname, '.env.tests')
dotenv.config({ path: resolvedPath })
// Increase webhook timeout for E2E tests that exercise the sync webhook route with subflow chains.
// Must be set before modules load since WEBHOOK_TIMEOUT_MS is a module-level constant.
process.env.AP_WEBHOOK_TIMEOUT_SECONDS = '120'
// The suites that start a real worker stop it in their teardown, and a stopping worker waits for its
// in-flight jobs for this long (60s by default, #585). Kept at the 5s it used to be, so the
// teardown budget in test/helpers/worker-teardown.ts still holds.
process.env.AP_WORKER_SHUTDOWN_GRACE_SECONDS = '5'
console.log('Configuring vitest ' + resolvedPath)
