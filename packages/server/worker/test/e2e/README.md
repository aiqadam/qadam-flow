# Sandbox + SSRF Integration Tests

These tests exercise the three SSRF hardening layers against real Linux primitives:

- **Egress proxy** — HTTP/CONNECT forward proxy with IP allowlist (`src/lib/egress/proxy.ts`)
- **iptables lockdown** — kernel OUTPUT chain that REJECTs sandbox UIDs except the proxy port (`src/lib/egress/iptables-lockdown.ts`)
- **Engine SSRF guard** — Node.js `dns.lookup` + `Socket.connect` + undici hooks (`engine/src/lib/ssrf/ssrf-guard.ts`)

They require `iptables`, the `isolate` binary, and `CAP_NET_ADMIN` / `CAP_SYS_ADMIN` — none of which are available on macOS. Run them through the provided Docker harness.

## Usage

From the repo root on any Docker host:

```bash
npm run test:sandbox-e2e
```

This builds a privileged container and runs the vitest suite inside it. See `Dockerfile` for the image definition and `scripts/run-sandbox-e2e.sh` for the wrapper.

If the suite is invoked directly on a host that lacks the required primitives it will skip with a clear message — it does not silently pass.

## Execution modes

`execution-modes.e2e.test.ts` is the answer to #375's "at minimum one job per `AP_EXECUTION_MODE`". For every mode — `UNSANDBOXED`, `SANDBOX_CODE_ONLY`, `SANDBOX_PROCESS`, `SANDBOX_CODE_AND_PROCESS` — it drives `createSandboxForJob` (the worker's own factory, so the mode → process maker choice, mounts and env are the production ones), starts the sandbox and runs a `BEGIN` flow that resolves the bundled `@aiqadam/qadam-webhook` qadam, runs a CODE step and returns a response. It asserts the engine's own run status over the worker socket, not a mock. Remove the isolate-mode qadam mounts and the two isolate cases fail; the two fork cases keep passing — that is the regression this test exists to catch.

Since #711 every mode also runs under both `AP_NETWORK_MODE` values, with the worker's real egress stack (`startEgressStack`) started per case: `STRICT` arms the production proxy (and, for the isolate modes, the kernel iptables lockdown) while the flow runs, and the engine's file uploads are asserted to be the only internal API calls that survive. Since #712 the flow's CODE step reports `typeof require`, read back from the uploaded run log: the V8 modes (`SANDBOX_CODE_ONLY`, `SANDBOX_CODE_AND_PROCESS`) see no `require` because the step runs in an isolated-vm context, while the fork modes (`UNSANDBOXED`, `SANDBOX_PROCESS`) run it in the no-op runner's child, where `require` exists. That is the actual `SANDBOX_CODE_ONLY` boundary — the engine process is a plain fork; only the CODE steps are V8-confined.

## Real third-party connectivity smoke

`sandbox-real-third-party.e2e.test.ts` brings up the same SANDBOX_PROCESS + STRICT stack used in production and reaches out to a curated list of public APIs (~30 hosts: OpenAI, Anthropic, Stripe, GitHub, Notion, etc.). It asserts:

- DNS resolves (no `EAI_AGAIN` — the production-outage signature).
- HTTPS via CONNECT through the egress proxy reaches the real origin (any HTTP status is accepted; we only assert the connection landed).
- AWS/GCP metadata endpoints and RFC1918 / loopback IPs remain blocked.

Tolerance: requires ≥80% of Group A hosts to succeed (one transient vendor outage shouldn't fail CI; a systemic break in DNS/proxy/iptables takes the whole list down). Auto-skips when no outbound internet (TCP/443 to `1.1.1.1` is unreachable).

## Why these exist alongside the unit tests

The unit tests under `packages/server/worker/test/lib/egress/` and `packages/server/engine/test/ssrf/` mock `execFile`, `spawn`, and kernel state. They prove the logic branches, not that the kernel is actually enforcing anything. These e2e tests close that gap.
