# Contributing

## Fixing a Jumia rejection

No fix for a Jumia rejection class merges without a test that asserts
against the **live error string** Jumia actually returned — not a
paraphrase, not a guess at the shape. Every existing test in
`__tests__/rejection-remedy.test.ts`, `__tests__/jumia-preflight.test.ts`,
`__tests__/prohibited-catalog.test.ts`, and
`__tests__/jumia-payload-conformance.test.ts` already follows this; keep
doing it.

Why: this codebase has shipped fixes for rejection wording that turned out
to be slightly off from what Jumia actually sends (a bracket placement, a
word order), and the mismatch only surfaced live. `classifyJumiaRejection`
(`lib/jumia/rejection-remedy.ts`) and the pre-push validators in
`lib/jumia/preflight.ts` / `lib/jumia/listing-ready.ts` all match against
Jumia's exact wire text with regexes — a test built from a remembered
summary of an error, rather than the string itself, can pass while the
regex it's meant to guard still doesn't match production.

Where to get the exact string:
- A live rejection currently on a listing: `listings.jumia_error`.
- Historical rejections and what they resolved to: `jumia_feed_outcomes`
  (see `supabase/migrations/2026-09-20_jumia-feed-outcomes.sql` and
  `lib/jumia/feed-outcomes.ts`) — every push's outcome is logged there
  (`live` / `rejected` / `blocked_locally`) with the raw error text and a
  fingerprint of the payload that produced it, specifically so a fix
  written later has real fixtures to test against instead of relying on
  whoever was watching when it happened.

## General

- Small, focused commits over big refactors.
- No placeholder/Lorem-ipsum code.
- `npx tsc --noEmit` and `npx jest` clean before opening a PR.
