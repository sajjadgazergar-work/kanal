# Adapter observed-behaviour docs

Per plan §18.1, each platform has a `<platform>-observed.md` file here,
**written by `probe.ts`**, not by hand. The probe runs against a live
platform account and records what the API actually does, so the adapter's
descriptor matches reality instead of the README.

This directory is empty until the probes are run against real accounts. The
convention for a probe run:

```
pnpm --filter @kanal/adapters-telegram run probe --channel @example
# writes docs/adapters/telegram-observed.md
```

## What a probe record captures

- The `[VERIFY]` annotations from the adapter descriptors (§10.3, §14.8):
  does the platform actually return `message_id` on send? Does it enforce the
  4096/1024 char limits, or split itself?
- Capability truth: which capabilities the live API supports versus the static
  descriptor's claim.
- Rate-limit behaviour: observed `429` + `Retry-After` semantics, bucket
  sizes, concurrency ceilings.
- Idempotency reality: whether the platform has a real idempotency key, or
  whether KANAL's client-side dedup (plan §10.5) is the only guard.

A probe failure does not block a release — it updates the observed doc. A
descriptor that contradicts its observed doc is a bug.
