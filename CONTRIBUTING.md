# Contributing

## Fixing a Jumia rejection

No fix for a Jumia rejection class merges without a test that asserts
against the **live error string** Jumia actually returned — not a
paraphrase, not a guess at the shape. Every existing test in
`__tests__/rejection-remedy.test.ts`, `__tests__/jumia-preflight.test.ts`,
`__tests__/listing-ready.test.ts`, `__tests__/prohibited-catalog.test.ts`,
`__tests__/restricted-words.test.ts`, and
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

## Promoting a live reject into a lasting defense

`jumia_feed_outcomes` is write-only today — nothing reads it automatically.
Turning a real `rejected`/`blocked_locally` row into a defense is a manual,
human-driven pass:

1. Pull recent rows (`select * from jumia_feed_outcomes where outcome in
   ('rejected','blocked_locally') order by created_at desc`), or run
   `npm run print-unfixed-rejects` (`scripts/print-unfixed-rejects.ts`) to
   get a short list of rows whose `raw_error` doesn't look covered yet —
   either `classifyJumiaRejection` returns `"unknown"` for it, or none of
   the five test files above appear to contain the string. The script's
   "covered" check is a cheap substring heuristic, not proof — always
   confirm by reading the actual test before deciding a class is handled.
2. Group by normalized error text; skip anything already covered.
3. Pick the right layer: detectable before push → a gate in
   `lib/jumia/preflight.ts` / `lib/jumia/listing-ready.ts` /
   `lib/jumia/prohibited-catalog.ts` / `lib/ai/restricted-words.ts` (prefer
   holding the push over shipping and finding out). Only knowable after
   Jumia answers, and only the seller can fix it → `classifyJumiaRejection`
   returns `kind: "seller"`. Fixable by a redraft → `"rerun"`. Fresh SKU
   only → `"repush"`.
4. Add the test with the exact string, per the rule above.

A scheduled/automatic version of this (a cron "miner") is a deliberate
follow-up, not done yet — the promote step above still needs a human
judgment call on which layer a new class belongs to.

## General

- Small, focused commits over big refactors.
- No placeholder/Lorem-ipsum code.
- `npx tsc --noEmit` and `npx jest` clean before opening a PR.
