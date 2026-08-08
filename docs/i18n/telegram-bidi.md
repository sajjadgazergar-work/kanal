# Telegram bidi behaviour — verified rendering matrix

Plan §14.8 flags the riskiest i18n surface: **embedded LTR runs inside RTL
paragraphs render differently across Telegram clients.** This document records
what was actually verified. It is the living home of the fixtures and
screenshots; a new client version updates this file, never the formatter code.

## Scope

A post can contain any of these inside a Persian (RTL) paragraph:

- a URL (`https://example.com/…`)
- an `@handle`
- a Latin product name (`OpenAI`, `Meta`)
- a number (`1,240`, `۱۰۲۴`)

The question: does the client keep these runs visually correct, or does the
surrounding RTL context reorder or mis-scope punctuation?

## Verified fixtures

> **[VERIFY] Render each fixture on Telegram Desktop, iOS, Android, and Web;
> attach a screenshot named `<client>-<fixture>.png` and record the verdict
> (pass / reorder / mis-scope) in the table.** Until a fixture is verified,
> the formatter's Persian mode applies the safe rules below.

| Fixture | Desktop | iOS | Android | Web | Notes |
| --- | --- | --- | --- | --- | --- |
| Persian text + trailing URL | — | — | — | — | |
| Persian text + `@handle` mid-sentence | — | — | — | — | |
| Persian text + Latin product name inline | — | — | — | — | |
| Persian text + number with Latin digits | — | — | — | — | |
| Persian text + number with Persian digits | — | — | — | — | |
| URL adjacent to Persian full stop | — | — | — | — | the risky one |

## Safe rules the formatter applies until verified

1. **URLs go on their own line** in Persian mode, never adjacent to Persian
   punctuation.
2. **Inline Latin runs are avoided adjacent to Persian punctuation.** Where a
   Latin product name is required, it sits between Persian words with spaces on
   both sides and no punctuation touching it.
3. Mixed-direction display in the dashboard always wraps user content in
   `<bdi>`; interpolated values inside translated strings are wrapped in
   `U+2068 FSI … U+2069 PDI` by the formatter helper, never by hand.

## Where this is enforced

- `packages/i18n` — the bidi helpers (FSI/PDI), tested.
- `packages/prompts` — the Persian mode of the formatter prompt rules; a lint
  rule forbids importing the UI locale inside `packages/prompts` (plan §14.8).
- `apps/web` — `<bdi>` and the FSI/PDI wrapper on all interpolated values.
