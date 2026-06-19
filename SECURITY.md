# Security Policy

Qadam Flow handles authentication, access control, and audit data, so we take
security reports seriously — including while those features are still maturing.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email **security@aiqadam.org** with:
- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one),
- the affected version or commit, and your environment.

You'll get an acknowledgement as soon as a maintainer sees it. We'll work with you on
a fix and coordinate disclosure once a patch is available. We won't pursue good-faith
research that respects users' privacy and data.

## Scope

- The Qadam Flow application and its first-party code.
- Qadam Flow is a derivative of Activepieces. Vulnerabilities in unmodified upstream
  code should also be reported to the [Activepieces project](https://github.com/activepieces/activepieces);
  we track relevant upstream fixes.

## A note on enterprise features

SSO, RBAC, audit logging, and SIEM output are built incrementally and audited before we
make any production-security claim (see the [Roadmap](./ROADMAP.md)). If you're evaluating
Qadam Flow for a regulated environment, check the roadmap status of these features first,
and reach out — we'd rather be honest about what's ready than oversell it.

## Supported versions

Early-stage project: security fixes target the latest `main`. A versioned support policy
will be defined as the project matures.
