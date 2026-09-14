# What the sandbox container does not have

Verified with `command -v`, not from memory. Three separate stalls in one session came from assuming
one of these was present.

| tool | state | consequence |
| --- | --- | --- |
| `bun` | **missing** | `turbo` cannot execute any task — `npm run lint-all`, `typecheck`, `test-unit` all die with `Unable to find package manager binary`, because `packageManager` is `bun@1.3.3`. `turbo … --dry=json` still works, so audits are fine and runs are not. |
| `jq` | **missing** | pipelines into it fail per iteration; use `gh --jq`, which needs no binary. |
| `python3` / `python` | **missing** | see the `generate → consume` entry in [verification-pitfalls.md](./verification-pitfalls.md). |
| `turbo`, `tsc` on PATH | missing | use `npx`. |
| `psql`, `redis-cli` | missing | integration tests need the docker-compose services, not a bare shell. |
| `node` | v22 | CI pins **24** (`_verify.yml`); a version-sensitive local result is not authoritative. |
| git hooks | **not installed** | `core.hooksPath` empty, no `.git/hooks/pre-push`, no `.husky/_`. A successful `RUN_CHECKS=yes git push` here is evidence the gate **did not run**. |
| `docker`, `gh`, `node`, `npx` | present | usable. |

So the authoritative local signals are `npx vitest`, `npx eslint`, `npx tsc` and
`turbo … --dry=json`; anything routed through `turbo run` or a git hook proves nothing here, and
saying so is better than substituting a command that returns clean.
