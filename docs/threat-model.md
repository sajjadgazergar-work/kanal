# KANAL threat model

This document is the implementation of plan §16. It is written down because a
security model that lives only in code review is not a model. When a failure
mode is accepted, it is stated here — not pretended away.

## Trust model: three zones (plan §16.1)

| Zone | May read | May hold tools of risk | May produce |
| --- | --- | --- | --- |
| `quarantine` | Untrusted ingested text (`source_item.body_text`) | ≤ 2, and only reads | Schema-validated structured output only. **No free text crosses the boundary** |
| `trusted` | Structured artefacts only (`Brief`, `Claim[]`, voice pack, prior revisions) | ≤ 1 | `PostDraft` and annotations |
| `deterministic` | Anything | n/a (no model) | Side effects |

### What an agent is structurally incapable of doing

Not "is instructed not to" — **cannot**:

1. **Publish.** No `platform.*` capability exists in the registry. A
   `publish_intent` row is created only by an HTTP handler authenticated as a
   human, or by the policy evaluator matching a signed policy. Agents have no
   write path to that table.
2. **Emit an arbitrary link.** `post_revision.allowed_urls` is computed
   deterministically from the canonical URLs of the cited `source_item` rows
   plus the channel's own configured links. `format.render` strips anything
   else.
3. **Read raw untrusted text while trusted.** There is no function that
   returns `source_item.body_text` to a trusted-zone step. The only crossing
   is a `Claim`: ≤ 320 characters, URL-stripped, markup-stripped,
   control-character-stripped, provenance-bearing, schema-validated.
4. **Spend beyond a cap.** The budget guard is at the provider client, below
   every agent.
5. **Escalate its own permissions.** Zone and tool set come from the manifest,
   loaded and validated before the run and hashed into
   `run.manifest_set_hash`. No runtime path mutates them.
6. **Talk to another agent.** Handoffs are typed rows. There is no shared
   transcript for one agent to poison.

**Defence in depth is explicitly labelled as secondary.** Delimiting and
spotlighting of untrusted text inside quarantine prompts, plus an
injection-pattern detector that writes `source_item.injection_flags`, are
**advisory only**: they raise review priority and lower trust score. They are
never the control that prevents harm, because pattern detectors for injection
are defeatable and building on them is how products get owned.

## Attack table (plan §16.2)

| # | Attack | Vector | Impact | Mitigation | Residual risk |
| --- | --- | --- | --- | --- | --- |
| 1 | Direct prompt injection in a source | Ingested RSS/HTML | Attacker-authored post | Zone isolation, `Claim` bottleneck, URL allow-list, policy gate | A benign-looking false claim can still reach a draft; mitigated by corroboration, not eliminated |
| 2 | Indirect injection via retrieved memory | Poisoned T3 corpus retrieved months later | Delayed compromise | T3 is permanently untrusted; retrieval returns `Claim` objects only | Same as #1 |
| 3 | Link laundering | Attacker gets an owned URL into `allowed_urls` by being a cited source | Traffic to attacker | `allowed_urls` derives from canonicalized cited URLs; source must already be configured and human-added | A user who adds a hostile feed gets hostile links; trust tiers + source-add confirmation are the control |
| 4 | Zero-width / homoglyph payloads | Unicode tricks in source text | Detector bypass, deceptive rendering | NFC normalization + zero-width strip at ingest; confusable detection on outbound domains | Novel confusables |
| 5 | Data exfiltration via generated markdown image | Model emits an image URL with data in the query string | Leak of draft content | Media comes only from `MediaBrief` with explicit file refs; no remote-URL images in rendered output | None known for the text path |
| 6 | SSRF via a user-supplied source URL | `html_selector` source pointing at `169.254.169.254` or `localhost` | Cloud credential theft | DNS resolution then IP deny-list check (RFC1918, loopback, link-local, CGNAT, IPv6 ULA/mapped) before connect, re-checked after every redirect hop; no `file:`/`gopher:`/`ftp:` | DNS rebinding between check and connect — mitigated by pinning the resolved IP into the connection |
| 7 | SSRF via a provider base URL | Malicious `baseUrl` in provider config | Internal network scan | Same IP deny-list, unless `KANAL_ALLOW_PRIVATE_PROVIDERS=1` (needed for local Ollama) — opt-in, documented, narrows rather than removes | An operator who enables it can scan their own network; acceptable |
| 8 | Webhook forgery | The `source.webhook` endpoint | Injected source items | HMAC-SHA256 over the raw body with a per-source secret, constant-time compare, 5-minute window, replay cache | Secret leakage |
| 9 | API key theft from the database | DB dump | Provider abuse at the victim's cost | AES-256-GCM envelope encryption with AAD binding; master key outside the DB | An attacker with both the DB and the environment has the keys — stated, not pretended away |
| 10 | Telegram bot token theft | Same | Channel takeover | Same encryption; token never returned by the API; `getMe` verification on load | Same |
| 11 | MTProto session theft | Sidecar container compromise | Full account takeover | Separate container, separate encryption key, no inbound network, read-only capability set, session encrypted at rest, one-command revoke | High impact by nature; mitigated by making the sidecar optional and loudly consented |
| 12 | Tenant crossing | Missing `WHERE org_id` | Data leak in hosted mode | RLS on every table, enabled from day one, plus a two-org test asserting zero cross-reads | `BYPASSRLS` jobs are the gap; enumerated and audited |
| 13 | Supply-chain compromise | A malicious npm dependency | Anything | pnpm committed lockfile, `--frozen-lockfile` in CI, Dependabot, `pnpm audit` gate, provenance-verified publishing, no `postinstall` scripts, CycloneDX SBOM per release | A compromised direct dependency at publish time |
| 14 | Malicious prompt pack from the community | User installs a third-party pack | Prompt-level manipulation | Packs are sandboxed templates with no I/O; cannot add tools or change zones; Git refs pinned by commit SHA; pack diff shown before install | A pack can still write persuasive text; it cannot exceed the manifest's capability set |
| 15 | Cost bomb | Injection or misconfiguration causing a generation loop | Financial | Per-run / per-channel / per-org caps; a global daily circuit halting all generation at 3× the 7-day average spend | A single expensive run within the cap |
| 16 | Self-host exposed to the internet | Default deployment | Full takeover | Binds `127.0.0.1`; refuses to start with default/empty `KANAL_SESSION_SECRET`; auth required from first boot, no anonymous mode; documented reverse-proxy + TLS recipe; `kanal doctor` warns on `0.0.0.0` without TLS | Users who ignore all of it |
| 17 | CSRF / session theft in the dashboard | Browser | Account takeover | `SameSite=Lax` cookies, `HttpOnly`, `Secure` when TLS, double-submit token on state-changing routes, strict CSP with no `unsafe-inline`, no third-party scripts | XSS in a dependency |
| 18 | XSS via post preview | Rendered Telegram HTML shown in the dashboard | Session theft | Preview renders from the sanitized entity tree into React elements, never `dangerouslySetInnerHTML` | — |

## Self-host hardening defaults (plan §16.3)

Shipped defaults, not documentation:

- Bind `127.0.0.1`.
- No default credentials, no anonymous mode; secrets refuse placeholder values.
- Containers run as a non-root uid with a read-only root filesystem and
  `cap_drop: ALL`.
- The sidecar container has no inbound ports and an egress allow-list of
  Telegram DC ranges only.
- Postgres is not published to the host.
- `docker compose` healthchecks on all four services.
- Automated daily `pg_dump` to a mounted volume, with a documented and CI-tested
  restore command.

## Where the code implements this

| Mechanism | Module |
| --- | --- |
| SSRF IP deny-list (v4 CIDRs, v6 ULA/mapped/NAT64) | `packages/sources/src/ip.ts` |
| Fetch discipline: redirect re-check, IP pinning, size cap | `packages/sources/src/fetcher.ts` |
| Zone-aware prompt assembly | `packages/prompts/src/zones.ts` |
| `Claim` sanitization (≤320 chars, strip URL/markup/control) | `packages/prompts/src/sanitize.ts` |
| Budget guard on every model call | `packages/core/src/budget.ts` |
| Provider envelope encryption (§11.7) | `packages/providers` |
| Egress deny mode (air-gapped) | `packages/providers/src/egress.ts` |
| RLS policies + `kanal.org_id` context | `packages/db/src/rls.ts` |
