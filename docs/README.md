# KANAL documentation index

| Document | What it is |
| --- | --- |
| [`threat-model.md`](threat-model.md) | Trust model, the six structural incapacities, the 18-attack table, hardening defaults. The implementation of plan §16 |
| [`ui-rules.md`](ui-rules.md) | The anti-slop checklist. Violating a rule blocks a design review. Plan §14.6 |
| [`adapters/`](adapters/README.md) | Per-platform observed-behaviour docs, written by `probe.ts` |
| [`i18n/telegram-bidi.md`](i18n/telegram-bidi.md) | Verified Telegram RTL/bidi rendering matrix and the safe formatter rules |
| [`decisions/`](decisions/) | Decision records (plan §21 format), numbered sequentially |

## Governance documents (repo root)

- `README.md` — what KANAL is and how to run it
- `CONTRIBUTING.md` — the contribution ladder and what we will not accept
- `GOVERNANCE.md` — decision-making model and its succession trigger
- `SECURITY.md` — vulnerability reporting (48-hour response commitment)
- `TRADEMARK.md` — the mark is not licensed by the AGPL

## Specification

The single authoritative spec is `KANAL — V1 Plan (Telegram channel agency,
agent-op *.md)` at the repository root. Code is the implementation; where a
doc and the code disagree, the code wins and the doc gets a decision record.
