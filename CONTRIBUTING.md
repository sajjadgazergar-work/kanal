# Contributing to KANAL

Thanks for wanting to help. This file is the plan §19.3 contract, written so
nobody wastes a weekend.

## What we will NOT accept (stated up front)

We will reject PRs that ship these, no matter how well-engineered they are:

- **Engagement automation** — like/boost/repost farming, engagement pods.
- **DM tooling** — mass-messaging or broadcast to non-subscribers.
- **Follower automation** — buy/fake/swap follower tooling.
- **Scraper connectors for platforms that prohibit scraping** — if the
  platform's terms forbid it, we do not ship a connector for it.
- **robots.txt bypass** — `safeFetch` honours robots.txt; that is a feature.
- **Anything that removes an approval gate by default** — the AUTO lane can
  reduce gates, but the default for a new channel is human-gated.

This list is a positioning statement as much as a policy. It is not open to
negotiation through the contribution ladder.

## Getting set up

```bash
git clone <your-remote>/kanal && cd kanal
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install
pnpm build        # must pass before anything else
```

## Definition of done (plan §18.3)

A change is done when all of these hold:

- [ ] Types pass with `strict` and no new `any`
- [ ] Unit tests cover the new branch
- [ ] A golden-file test covers any new prompt
- [ ] `pnpm kanal:doctor` exits 0
- [ ] RTL and `en-XA` screenshots are updated (UI changes)
- [ ] Both `en` and `fa` catalogue keys exist (i18n changes)
- [ ] New spans appear in the trace viewer (agent changes)
- [ ] The degraded-operation matrix reflects any new failure mode
- [ ] Docs updated
- [ ] A migration, if any, is reversible and tested against a seeded database

## Committing

Every commit carries a `Signed-off-by` trailer — this project uses the
**Developer Certificate of Origin** (DCO), not a CLA:

```
git commit -s
```

By signing you certify you wrote it or have the right to contribute it.
See <https://developercertificate.org/>.

## Testing

```bash
pnpm test:unit          # unit tests across all packages
pnpm eval:run           # eval regression (composite drop ≥ 0.05 blocks merge)
pnpm kanal:doctor       # static structure checks
```

The eval gate is a hard merge block: `pnpm eval:run` must not drop the mean
rubric composite by ≥ 0.05.

## The community surface: packs

Prompt packs and voice packs are the fastest way a non-engineer can make a
real contribution. A niche starter pack (crypto, tech news, local news,
product changelog, sports) lives in `packs/` and takes an afternoon:

```
packs/<your-pack>/
  pack.yaml            # id, semver, core_api, locales
  vars.schema.json     # the variables your templates consume
  en/*.tmpl            # templates (MiniJinja-compatible subset)
  fa/*.tmpl
```

A pack is validated at load: undeclared variables, missing locales, and
out-of-range `core_api` all fail before any run. Packs are sandboxed — they
cannot add tools, change zones, or touch the network.

## Licensing

- `packages/contracts` and `packages/adapters/core`: **Apache-2.0**.
- Everything else: **AGPL-3.0-or-later**.

Contributing is consent to contribute under those terms. There is no CLA.

## Reporting security issues

Do not open a public issue. Email the address in `SECURITY.md` (GPG key
published there). Response commitment is **48 hours**.
