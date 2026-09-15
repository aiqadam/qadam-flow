# Agent delegation — never improvise the brief

When delegating to a subagent (reviewer or any other), the agent's instructions ARE the
charter file under `.agents/agents/<name>.md` — hand that file to the agent as its binding
instructions (tell it to read the file and follow it exactly). Never re-type, paraphrase,
or "improve" a charter from memory: the charters are the source of truth, and a brief I
invent on the spot drifts from them by construction.

If the task needs an agent that has no charter (a new one), or an existing charter's
description/scope needs to change, do not guess — ask the user first. Adding or editing
`.agents/agents/*.md` is a user decision, not an agent decision.

## No endpoint and no agent CLI: emit the prompts

`npm run review` needs either an OCR LLM endpoint or an agent CLI on `PATH`; when neither
exists, `--mode auto` skips. Do not answer that with an improvised brief — emit the
delegation prompts (the same rules, diffs and `<review-findings>` contract `--mode
delegate` would have sent) and have a harness-native subagent answer them:

```bash
npm run review -- --from <base> -b "<feature description>" --emit-prompts .git/qadam-review/prompts
```

The command calls no LLM: it writes `batch-NN.prompt.md` plus `manifest.json`. Hand each
prompt to one subagent as-is — it is self-contained and needs no tools — and collect the
returned `<review-findings>` blocks as the artifact, the same `comments[]` shape
`.git/qadam-review/last.json` carries. Give that artifact to `code-quality` in its brief
and say the findings came from the emitted prompts (no external review backend ran).