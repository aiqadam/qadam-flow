# Subagents — when to delegate, and how to brief them

Two halves, both binding: **when** you must hand work to a subagent, and **how** the brief
is built. Skipping the first is the failure this file exists to stop — a charter nobody
ever invokes is documentation, not a reviewer.

## When: the delegation matrix

| Agent | Delegate when | Binding |
| --- | --- | --- |
| `code-quality` | Before you report **any** code change complete — every diff, every time | Mandatory |
| `app-sec` | Before you report complete any change touching server code, auth, entities, migrations, or outbound HTTP | Mandatory |
| `server` | You are implementing in `packages/server/api` and want the work done by a specialist rather than inline | Optional |
| `web` | You are implementing in `packages/web` and want the work done by a specialist rather than inline | Optional |
| `changelog` | A user-visible change needs release notes | Optional |

Read the matrix literally:

- **"Before you report complete", not "before merging".** A session that opens a PR and
  hands it to a human has finished its task; "merging" is something that happens later, to
  someone else, and pinning the review to it is how every review gets skipped. Docs-only,
  CI-only and comment-only diffs are still code changes — run `code-quality` on them too;
  it is cheap and it catches stale instructions.
- **A `DO NOT MERGE` verdict is blocking.** Fix it and re-run the reviewer. Forwarding the
  verdict to the user as a note, and calling the task done, is not an option the charters
  give you.
- **Never review your own work.** The agent that wrote the code must not be the agent that
  reviews it: an author reproduces its own blind spots, and the entire value of the second
  pass is that it is an independent reading. If you wrote the code yourself, both reviewers
  are subagents — you do not review it yourself either.
- **Reviewers are read-only by charter.** A reviewer that edits code has stopped being a
  reviewer; apply its findings yourself.
- **Reviewers verify against the code, never against the PR body.** The failure worth
  guarding against is a confident verdict resting on the wrong file, or on a
  same-named-but-different symbol.
- **Optional means optional.** `server`, `web` and `changelog` exist to parallelise or
  specialise implementation work; not delegating to them is a normal, unremarkable choice
  that needs no justification. The two reviewers are not in that category.

## How: never improvise the brief

When delegating to a subagent (reviewer or any other), the agent's instructions ARE the
charter file under `.agents/agents/<name>.md` — hand that file to the agent as its binding
instructions (tell it to read the file and follow it exactly). Never re-type, paraphrase,
or "improve" a charter from memory: the charters are the source of truth, and a brief I
invent on the spot drifts from them by construction.

If the task needs an agent that has no charter (a new one), or an existing charter's
description/scope needs to change, do not guess — ask the user first. Adding or editing
`.agents/agents/*.md` is a user decision, not an agent decision.

## Reviews: run the pass before spawning

Before spawning a `code-quality` reviewer, run the advisory pass for the range under
review:

```bash
npm run review -- --from <base> -b "<feature description>"   # or --commit <sha>
```

- The reviewer's brief carries: the charter path, the feature description (PR body /
  ticket), and the artifact the pass produced — `.git/qadam-review/last.json`, or the
  findings collected from the emitted prompts when there was no backend (below). Hand
  the same artifact to `app-sec` when it runs alongside.
- Exit codes: 0 — proceed; 1 — the pass failed (it is advisory), say so in the brief;
  2 — `critical` findings, list them explicitly in the brief.
- Want an uncorrelated second reader? `--mode delegate --agent <CLI other than your
  own>`; plain `--mode auto` otherwise.
- If `ocr` is missing entirely, point at the setup in [CONTRIBUTING.md](../../CONTRIBUTING.md)
  and continue without the artifact — never install it silently during a review.

## No endpoint and no agent CLI: emit the prompts

`npm run review` needs either an OCR LLM endpoint or an agent CLI on `PATH`; when neither
exists, `--mode auto` skips. Do not answer that with an improvised brief — emit the
delegation prompts (the same rules, diffs and `<review-findings>` contract `--mode
delegate` would have sent) and have a harness-native subagent answer them. This still
needs the `ocr` binary for preview/rules, but no endpoint:

```bash
npm run review -- --from <base> -b "<feature description>" --emit-prompts .git/qadam-review/prompts
```

The command calls no LLM: it writes `batch-NN.prompt.md` plus `manifest.json`. Hand each
prompt to one subagent as-is — it is self-contained and needs no tools — and collect the
returned `<review-findings>` blocks as the artifact, the same `comments[]` shape
`.git/qadam-review/last.json` carries. Give that artifact to `code-quality` in its brief
and say the findings came from the emitted prompts (no external review backend ran).