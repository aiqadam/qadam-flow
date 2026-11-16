# CanaryGuard Qadam

Deterministic prompt-injection firewall and AI input sanitizer powered by CanaryGuard 402.

- **Local Mode (`local_fast`, default)**: Runs pure-TypeScript deterministic sanitization directly in-process in **< 2ms** with zero network latency and zero external dependencies.
- **Cloud API Mode (`cloud_api`)**: Calls `https://canaryguard-402.onrender.com` (`/v1/sanitize/preview` or paid `/v1/sanitize` when an x402 `PAYMENT-SIGNATURE` is supplied).

## Building

Run `npx turbo run build --filter=@aiqadam/qadam-canaryguard` to build the library.
