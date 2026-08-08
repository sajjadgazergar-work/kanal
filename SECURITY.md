# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Send a report to the security contact
(`security@kanal.dev` — replace with the project's real address before
release) with the subject `[KANAL-SEC] <one-line summary>`.

GPG key: **[PUBLISH GPG KEY FINGERPRINT HERE before public release]** — all
reports should be encrypted to this key when they contain exploit detail or
reproducible attack code.

**Response commitment: 48 hours** (plan §19.3). You will get an
acknowledgement, a triage, and a timeline. If the issue is accepted, a fix is
coordinated and released before the report becomes public.

## What is in scope

The threat model lives in `docs/threat-model.md`. In scope, in priority order:

1. Anything that lets a source item or retrieved artefact cause an
   unauthorized publish (plan §16.1 — zone crossing, capability escalation,
   link laundering).
2. SSRF in the source fetcher or provider base URLs (attack table #6, #7).
3. Webhook forgery and replay (attack #8).
4. Provider/Telegram credential theft, at rest or in transit (attacks #9–#11).
5. Tenant crossing via RLS (attack #12).
6. Self-host exposure / auth bypass (attacks #16–#18).
7. Supply-chain or prompt-pack compromise (attacks #13–#14).

Out of scope: attacks on a deployment the operator deliberately weakened
(e.g. `KANAL_ALLOW_PRIVATE_PROVIDERS=1`, binding to `0.0.0.0` without TLS,
`KANAL_PUBLISH=off` removed). Those are documented operator choices, not bugs.

## Supported versions

Security fixes land on the latest release. There is no LTS promise for V1;
upgrade and report.

## Bug bounty

None currently. Credit goes in the release notes and, with your consent, a
`SECURITY.md` acknowledgement list.
