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
review. **An agent always runs it in emitted-prompts mode** and answers the prompts with
its own harness's subagents:

```bash
npm run review -- --from <base> -b "<feature description>" --emit-prompts .git/qadam-review/prompts   # or --commit <sha>
```

Not `--mode auto`, and not `--mode delegate`, even when an OCR endpoint or another agent
CLI is available. Both hand the review to a process outside your harness: `auto` picks
whatever agent CLI it finds on `PATH` (e.g. `opencode`). You cannot see or steer that
process, you cannot run its batches in parallel, and you cannot tell a slow run from a
hung one. Emitted prompts carry the same rules, diffs and `<review-findings>` contract,
and your own subagents answer them, where you can see them. `--mode auto` stays the
default for a human at a terminal; it is not the agent's choice.

- The reviewer's brief carries: the charter path, the feature description (PR body /
  ticket), and the artifact the pass produced — the findings collected from the emitted
  prompts (below). Hand the same artifact to `app-sec` when it runs alongside.
- The emit step itself can still fail (e.g. a bad `--from`). Say so in the brief and
  continue without the artifact — the pass is advisory.
- A returned finding with severity `critical` goes into the brief explicitly, the same as
  exit code 2 in a backend run.
- If `ocr` is missing entirely, point at the setup in [CONTRIBUTING.md](../../CONTRIBUTING.md)
  and continue without the artifact — never install it silently during a review.

## Answering the emitted prompts

The emit step needs the `ocr` binary for preview and rules, but no LLM endpoint, and it
calls no LLM. It writes `batch-NN.prompt.md` plus `manifest.json`.

- Hand each prompt to its own subagent as-is, all of them in parallel. A prompt is
  self-contained and needs no tools. Tell the subagent to read that one file and reply
  with only the `<review-findings>` block. Do not paraphrase the prompt or paste an
  improvised brief in its place.
- Collect the returned blocks as the artifact. They use the same `comments[]` shape that
  `.git/qadam-review/last.json` carries in a backend run.
- Give the artifact to `code-quality` in its brief, and say the findings came from the
  emitted prompts (no external review backend ran).
