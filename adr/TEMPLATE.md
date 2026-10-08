---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: YYYY-MM-DD            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#NNN"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# NNNN. Title stated as the decision, not the topic

<!-- "Official qadams are installed from a versioned local store", not "Qadam versioning". -->

## Decision

<!-- Two to six sentences. What we will do, stated so a reader who stops here knows the answer. -->

## Context

<!-- The problem and the forces at play. Link the issue, incidents, PRs and measurements.
     Cite code as `path:line` at a commit SHA. State what is true today, not what is planned. -->

## Options considered

### Option A — <name> (chosen)

<!-- What it is, and why it wins. -->

### Option B — <name>

<!-- What it is, and why it lost. Every rejected option needs a reason. -->

## Consequences

<!-- What becomes easier. What becomes harder. New obligations (API stability, migrations,
     docs, release gates). What is now irreversible. Risks and how they are watched. -->

## Evidence

<!-- Measurements and how they were taken (machine, commit, command), prototypes, prior art.
     Delete this section only if the decision rests on no measurement at all. -->

## Follow-ups

<!-- Implementation tickets this ADR implies, with issue links once filed. -->
