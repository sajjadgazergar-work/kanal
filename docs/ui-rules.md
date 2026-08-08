# UI rules (anti-slop checklist)

A reviewable checklist from plan §14.6. **Violating a rule blocks a design
review.** When you add a screen or component, walk this list; when you review
one, walk it again and write the rule number in the review comment.

1. **No gradient hero, no glassmorphism, no purple-to-blue mesh background.**
2. **No fake terminal, no typewriter effect** on anything that is not a real
   token stream (the agent-ops canvas token view is the only exception, and it
   is driven by real `token` events on the SSE bus).
3. **No animated "AI is thinking" state that is not bound to a span.** If no
   span exists, the canvas shows nothing moving. That is the ship criterion
   (plan §13.1).
4. **No emoji in product chrome.** Emoji appear only inside user-content
   previews.
5. **No sentence in the UI longer than 14 words. No paragraph longer than 3
   sentences.**
6. **No number without a unit and a time window.** "1,240" is banned;
   "1,240 views · last 24h" is required.
7. **No spinner that can run longer than 3 s without becoming a determinate or
   explanatory state.**
8. **No modal for anything reversible.** Modals are reserved for irreversible
   confirmations.
9. **No toast for an outcome the user must act on.** Those become durable
   cards.
10. **No "Something went wrong."** Every error names the subsystem, the cause,
    and one action, and carries a copyable diagnostic id (the `trace_id`).
11. **No decorative iconography on data rows.** Icons carry meaning or are
    absent.
12. **No more than two typefaces and five text sizes per screen.**
13. **No dark pattern on the MTProto consent screen:** no pre-checked box, no
    "Recommended" badge, no colour advantage for the risky choice.
14. **No auto-refresh that moves content under a cursor.** New items queue
    behind a "3 new" pill.

## States (plan §14.7)

| State | Rule | Example |
| --- | --- | --- |
| Empty (first run) | Never a blank canvas. One sentence of what goes here, one primary action, one link to a 90-second example | "No sources yet. Add an RSS feed and the strategist starts finding topics." |
| Empty (filtered) | Distinguish from first-run. Show the filter and a clear-filter action | — |
| Loading | Skeletons only where layout is known; otherwise a determinate progress with the current step named | Provider test streams `dns → tcp → tls → http → parse → probing` |
| Error | Subsystem + cause + one action + a copyable diagnostic id (the `trace_id`) | §11.3 message set |
| Degraded | A persistent, dismissible-per-session banner naming exactly what is reduced | "Analytics limited to subscriber count — the stats sidecar is off." |
| Stale | Any metric older than its refresh interval renders with its capture time and a muted tone | "12,430 views · as of 09:12" |
