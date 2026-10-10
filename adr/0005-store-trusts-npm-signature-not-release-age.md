---
status: accepted            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-10            # date of the decision; the draft date while proposed
deciders: [binalirustamov]  # GitHub handles of the maintainers who decided
issue: "#806"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0005. The versioned store trusts the npm signature over the exact pin a flow chose, not release age; versions resolve from the catalogue or the store

Builds on: ADR-0003 (the versioned store, the fetch path, the mandatory npm signature for
`@aiqadam/*`, the catalogue) and ADR-0001 (the caret-range promise). Relies on ADR-0004 (the
`follow` pass and the export rewrite, which must resolve like everything else here).

## Decision

For the versioned store's fetch path (ADR-0003 "Fetching"), trust rests on the npm signature over
the bytes a flow pinned, not on the age of the release.

1. **An exact official pin is trusted by npm's signature, not by release age.** When a flow is
   pinned to an exact `@aiqadam/*` version the store does not hold, the fetcher reads the version
   document, verifies npm's signature over `<name>@<version>:<dist.integrity>` against the keys
   pinned in the image (`npmPackageSignature`, #482 / #780 / #881), and only then downloads the
   tarball and stores it held to that integrity. The legacy bun-workspace `minimumReleaseAge`
   three-day quarantine (#482 item 3) does **not** apply to this path. It guards a resolver that
   picks the newest version in a range, giving a malicious publish time to be noticed; this path
   never picks — it fetches exactly the version a person pinned, and substituted bytes are refused
   by the signature over their integrity, not by their age. **Accepted risk, stated plainly:** a
   malicious release published with the project's own npm credentials is not distinguished by the
   signature. The quarantine would only delay such a release, and the real protection is npm
   provenance, which is a separate follow-up.

2. **Resolve versions from the catalogue or the store, never "the newest from the registry".** Any
   code that offers or moves a version — the builder's "update available", #782's import
   normalisation, ADR-0004's `follow` pass, ADR-0004's export rewrite — takes its version from the
   catalogue or the store, never by asking a registry for the newest version. A corollary: a
   non-`@aiqadam` / custom pin is not looked up on the public registry; that is deferred to #478,
   which will record which registry a platform installs from.

This builds on ADR-0003 and changes nothing in it: the store, the fetch triggers, the catalogue and
the fallback stay as ADR-0003 decided. It answers the `minimumReleaseAge` question #806's scope list
left open, and it fixes the resolution rule every later caller must follow.

## Context

ADR-0003's "Fetching" decided that a version missing from the store is fetched from npmjs, or from a
registry configured by URL and token, when a flow is published or imported, and in the background at
start-up for every pinned version that is missing. #806 implements that path. Its scope list
(`gh issue view 806`) leaves one question open — "`minimumReleaseAge` quarantine vs exact `@aiqadam/*`
pins (#477, 2026-09-22): decide the exemption for signature-verified `@aiqadam/*`" — and the first
slice (`ae6a4a4e`) implements its answer, recorded here as a decision.

**Why the quarantine exists, and why it does not fit this path.** The three-day `minimumReleaseAge`
quarantine (#482 item 3) protects the legacy bun workspace, where bun resolves a range and picks the
*newest* version that matches on its own. A malicious or hijacked publish that lands in that window
has a few days to be noticed before a resolver would install it. The store's fetch path does not
resolve a range. A step stores an exact version and a version apart from the name
(`packages/web/src/features/qadams/utils/qadam-selector-utils.ts:242`,
`packages/server/api/src/app/mcp/tools/ap-add-step.ts:121` at `2b1f313a`, cited in ADR-0003's
Context); the fetch path asks for that exact `name@version`. A quarantine there would only delay an
official release a person explicitly chose, without guarding a resolution this path does not do.

**The trust anchor is the signature, not the integrity.** npmjs signs the string
`<name>@<version>:<dist.integrity>` and publishes the signature in the version document's
`dist.signatures`. `dist.integrity` alone proves the bytes match what the registry served; it says
nothing about *who* served them, so an internal mirror or a rewriting proxy can serve its own
matching bytes and integrity. The signature, verified against keys pinned in the image, is what
binds the bytes to npmjs. The keys are pinned rather than fetched from `/-/npm/v1/keys` because
reading the key from the same registry that served the signature is circular — a mirror serves its
own key beside its own signature and the check passes. The cost of pinning is that an npmjs key
rotation stops official fetches until an image carries the new key; that is accepted, because
"unknown key id, so allow it" would hand an attacker the bypass. The check is fail-closed: without a
valid signature nothing is stored (the fetch path's signature gate; #806, slice 1). Each verified
signature is recorded beside the store (`qadam-signature-ledger.ts`; #780 / #881), so a restart does
not need the registry to know a version was signed.

**Resolution has more than one caller.** A version is offered or moved by several places: the
builder's "update available", #782's import normalisation, ADR-0004's `follow` pass on a `-main`
instance (`94ebec9c`, #854), ADR-0004's export rewrite of a snapshot pin (`c639f50c`, #853), and
ADR-0003's unavailable-version fallback (`58d09ab1`, #808). Each of them turns a pin or a range into
a concrete version. If any of them asks a registry for the newest version, it reintroduces exactly
the range resolution the quarantine existed to guard, and it gives a stolen npm credential a way to
move every flow it can reach onto a newer, attacker-published version — worse than the case the
quarantine covers, because the move is automatic. So the one rule they must share: the target comes
from the catalogue or the store.

**Custom names are not asked of npmjs.** A custom qadam is installed by the worker from whatever
registry bun is configured with, often a private one, and nothing records which. Asking npmjs for a
custom name would leak the private name and let whoever publishes it there answer, and what it
answered would sit in the platform's own namespace for good. A custom pin is therefore not fetched
until #478 records which registry a platform installs from.

## Options considered

### Option A — the signature over the exact pin replaces the quarantine; resolution from the catalogue or the store (chosen)

The signature is the correct tool for the thing being trusted: it binds exactly the bytes a person
pinned, so a substituted tarball is refused regardless of timing, while an official release a flow
pins runs the day it is published. The rule applies only to exact versions a person chose; any caller
that turns a range into a version takes that version from the catalogue or the store, so the range
resolution the quarantine guarded never happens on this path. Together the two parts give one
coherent trust story: what was pinned and signed runs immediately, and nothing resolves a moving
target behind the user's back.

### Option B — keep the quarantine on the store path

Rejected. It is the wrong tool: it guards a resolver that picks the newest version in a range on its
own, and this path does no such resolution. Applied here it would only delay an official release a
person explicitly pinned — precisely the release ADR-0003 exists to make run on the day it is
published — while buying nothing against the substitution it appears to cover, which the signature
already refuses by integrity.

### Option C — integrity only, no signature

Rejected. `dist.integrity` proves the bytes match what the registry served, not who served them. A
mirror or a rewriting proxy serves its own matching bytes and integrity and the check passes; the
signature is the only thing that binds the bytes to npmjs. Integrity alone is not a trust anchor.

### Option D — "the newest from the registry" for updates and moves

Rejected. It reintroduces the range resolution the quarantine existed to guard, and it does so on a
worse path: an automatic move rather than an install a person chose. A stolen npm credential could
publish a newer version and every caller would take it. npm provenance is the real fix, later; until
then the catalogue and the store are the sources a move may pick from.

## Consequences

**Easier.** An official release that a flow pins runs the day it is published, with no three-day
wait. The store trusts the signer rather than the clock, so the question "is this old enough?" never
arises on the fetch path. A restart verifies from the persisted signatures without reaching the
registry.

**New obligations.**
- The signature is the sole gate for the store's fetch path, so the keys pinned in the image must be
  maintained: the refresh procedure (read `https://registry.npmjs.org/-/npm/v1/keys`, add new
  non-expired entries, keep the outgoing one until it is gone) is now a release obligation, not a
  nicety.
- Resolution code must never ask a registry for "the newest". The builder, #782's import
  normalisation, ADR-0004's `follow` and export rewrite all take their target from the catalogue or
  the store.
- The store's fetch path stays under `app-sec` review (outbound fetch, credentials), as #806 already
  requires.

**Harder / risks.**
- A malicious release published with the project's own npm credentials is not distinguished by the
  signature; the quarantine would only delay it, so this is accepted rather than mitigated here. The
  real mitigation is npm provenance, a separate follow-up.
- An npmjs key rotation stops official fetches (SIGNATURE_REFUSED) until an image carries the new
  key; those steps run the image's build or go to ADR-0003's fallback in the meantime. Accepted, to
  avoid the trivial "unknown key id, allow" bypass.
- Pins to legacy `0.x` npm versions carry no `metadata.json`, so the store refuses them and the pin
  is UNFETCHABLE until ADR-0003's `@aiqadam/*` override path lands; that is deferred, not a gap this
  decision opens.

**Irreversible / accepted risk.** Credential theft is not caught by the signature until provenance
covers it. The rule that resolution never asks for "newest" is what keeps that exposure bounded to
the exact version a person pinned.

**Watch.** npm provenance (the real fix for the credential-theft case). The catalogue and the store
as the single source every version-offering or version-moving caller reads from.

## Evidence

- The fetch path's own reasoning, including the no-quarantine paragraph and the signature gate:
  `packages/server/api/src/app/qadams/version-store/qadam-version-fetcher.ts` (#806, slice 1; the file
  is introduced by that PR, so it has no line to cite on `main` yet).
- The trust anchor and why the keys are pinned:
  `packages/server/utils/src/npm-package-signature.ts` (`NPM_SIGNING_KEYS`, the `pinned` /
  `verifying` verifier, the rotation cost).
- The persisted proof: `packages/server/utils/src/qadam-version-store/qadam-signature-ledger.ts`;
  #780, merged as #881 (`dbb05fe1`).
- The quarantine's origin and its guard on range resolution: #482 item 3 (#477, 2026-09-22).
- The version-moving callers this rule binds: ADR-0004 `follow` (`94ebec9c`, #854), ADR-0004 export
  rewrite (`c639f50c`, #853), ADR-0003 fallback (`58d09ab1`, #808), and #782 import normalisation.
- ADR-0003 (the store, the fetch triggers, the mandatory `@aiqadam/*` signature, the catalogue).

## Follow-ups

- #478 — configurable qadam registry (`QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN`) and store GC;
  the registry a platform installs from, which also lifts the custom-name deferral.
- npm provenance — the trust anchor for *who* published a release and with whose credentials, which
  the signature cannot tell apart.
- #782 — import normalisation must take its version from the catalogue or the store, not from a
  registry's newest.
