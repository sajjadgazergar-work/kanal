# KANAL

**KANAL** is a self-hostable framework that runs a Telegram channel the way a
small agency would: it finds sources, drafts, fact-checks, formats, gets
approval, schedules, publishes, and measures — as one durable state machine
with a human in the loop when you want one, and unattended when you do not.

This repository is the implementation of the design in
`KANAL — V1 Plan (Telegram channel agency, agent-op *.md)`.

## What it does

Three lanes, one Postgres-backed state machine (plan §5):

- **AUTO** — a channel runs unattended; the pipeline finds, drafts, checks,
  formats, and publishes, with zero policy incidents as the bar.
- **CO-PILOT** — the pipeline does the finding and drafting; a human approves
  the topic, then the publish.
- **MANUAL** — a human writes, formats, and schedules; the runtime guarantees
  exactly-once publish and a durable approval trail.

Every run is a set of typed stages, each emitting OpenTelemetry spans. The
agent-ops canvas in the dashboard renders the same spans the trace viewer
queries — if the canvas shows an agent working, a span exists (plan §13.1).

## Layout

```
apps/
  web/                 Next.js 15 dashboard
  api/                 Fastify 5: REST + SSE + webhook receiver
  worker/              all four worker roles (pipeline, ingest, publish, metrics)
  sidecar-mtproto/     optional, separate image + network policy
packages/
  contracts/           Zod schemas, contract ids, JSON Schemas        (Apache-2.0)
  core/                runtime, stages, capability registry, budget guard
  db/                  Drizzle schema, migrations, RLS policies
  adapters/            PlatformAdapter interface + conformance kit     (Apache-2.0)
  providers/           dialects, capability probe, routing, circuit breaker
  prompts/             prompt packs, MiniJinja-compatible renderer
  evals/               rubric, judge, golden sets, regression runner
  sources/             connectors, canonicalizer, dedup, trust scoring
  otel/                span taxonomy, attribute allow-list, OTLP fork
  safety/              guardrails, moderation, PII, audit chain
  i18n/                ICU catalogues (en, fa), bidi, Jalali
  ui/                  design tokens, primitives, agent-ops canvas
docker/                compose stacks + multi-arch image build
docs/                  threat model, UI rules, decision log, i18n notes
```

## Quick start

See `docker/README.md`. In short:

```bash
cp docker/.env.example docker/.env        # then fill in real secrets
cp kanal.config.example.yaml kanal.config.yaml
docker compose -f docker/compose.yml up -d
```

The API binds `127.0.0.1:3001`, requires a real `KANAL_API_KEY`, and exposes
no admin port. Put TLS in front with the included nginx snippet.

## Verification

```bash
pnpm build            # types + compile across the monorepo
pnpm test:unit        # unit tests across all packages
pnpm eval:run         # eval regression (composite drop ≥ 0.05 blocks merge)
pnpm kanal:doctor     # static structure checks — exits 0 when sound
```

## Security

The threat model is `docs/threat-model.md`. Report vulnerabilities per
`SECURITY.md` (48-hour response commitment).

## Contributing

`CONTRIBUTING.md` — including the list of things we will not accept (engagement
automation, follower automation, robots.txt bypass, removing approval gates).
`GOVERNANCE.md` describes decision-making; `TRADEMARK.md` covers the mark.

## License

AGPL-3.0-or-later, except `packages/contracts` and `packages/adapters/core`
which are Apache-2.0. DCO-signed contributions; no CLA. See `LICENSE` and
`CONTRIBUTING.md`.
