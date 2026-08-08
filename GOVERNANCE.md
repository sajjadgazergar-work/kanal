# Governance

This is the implementation of plan §19.3. It states how decisions are made,
who can make them, and how that changes over time. It is deliberately short.

## Current model: BDFL-with-published-succession (first 18 months)

- Maintainers decide. Decisions are recorded in `docs/decisions/NNNN-*.md`
  using the format below.
- There is no foundation, no steering committee, and no theatre. That is a
  feature: with a handful of contributors, pretending otherwise wastes
  everyone's time.
- **The trigger to move to a technical steering committee is 5 people with
  sustained commit history over 6 months.** When that number is reached, the
  decision is recorded as a decision doc, and the committee's membership and
  quorum are agreed there — not improvised when the moment arrives.

## Contribution ladder

| Rung | How you get there | What it grants |
| --- | --- | --- |
| First PR | Merge a non-trivial change | A reviewer in your future PRs |
| Recurring contributor | 3+ merged PRs, any size | Review requests for your areas |
| Area maintainer | Sustained work in one directory (adapters, i18n, packs) | Merge rights in that directory via `CODEOWNERS` |
| Core maintainer | Trust over time + a decision doc | Merge rights repo-wide, decision participation |

## Decision records (`docs/decisions/NNNN-*.md`)

Every decision that changes the public contract, the security model, the lane
semantics, or the eval gates is recorded. Format (plan §21):

```markdown
# NNNN — Short title

- Status: proposed | accepted | superseded by NNNN
- Deciders: @usernames
- Date: YYYY-MM-DD

## Context
<!-- What was true, what changed, who this affects -->

## Decision
<!-- The choice, in one paragraph -->

## Consequences
<!-- What gets easier, what gets harder, what we are deliberately not doing -->
```

Number sequentially. A superseded decision stays, linked from its successor —
git history is not the archive, the decision log is.

## Trademark

The KANAL name and mark are held separately from the copyright and are **not**
licensed by the AGPL. See `TRADEMARK.md`.

## Response commitments

- Issue triage: **3 business days**.
- Security reports: **48 hours** via the channel in `SECURITY.md`.

## What we will not accept

Stated up front in `CONTRIBUTING.md` — engagement automation, DM tooling,
follower automation, scraper connectors for platforms that prohibit scraping,
robots.txt bypass, and anything that removes an approval gate by default.
This list is a positioning statement as much as a policy; it is not open to
negotiation through the contribution ladder.
