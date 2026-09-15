# Agent delegation — never improvise the brief

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
  ticket), and `.git/qadam-review/last.json` — the artifact the pass writes
  (`comments[]`).
- Exit codes: 0 — proceed; 1 — the pass failed (it is advisory), say so in the brief;
  2 — `critical` findings, list them explicitly in the brief.
- Want an uncorrelated second reader? `--mode delegate --agent <CLI other than your
  own>`; plain `--mode auto` otherwise.
- If `ocr` is missing, point at the setup in [CONTRIBUTING.md](../../CONTRIBUTING.md)
  and continue without the artifact — never install it silently during a review. When
  `app-sec` runs alongside `code-quality`, hand it the same artifact.