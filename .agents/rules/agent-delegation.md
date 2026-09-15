# Agent delegation — never improvise the brief

When delegating to a subagent (reviewer or any other), the agent's instructions ARE the
charter file under `.agents/agents/<name>.md` — hand that file to the agent as its binding
instructions (tell it to read the file and follow it exactly). Never re-type, paraphrase,
or "improve" a charter from memory: the charters are the source of truth, and a brief I
invent on the spot drifts from them by construction.

If the task needs an agent that has no charter (a new one), or an existing charter's
description/scope needs to change, do not guess — ask the user first. Adding or editing
`.agents/agents/*.md` is a user decision, not an agent decision.