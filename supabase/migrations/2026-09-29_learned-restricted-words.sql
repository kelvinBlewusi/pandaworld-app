-- ─── Words Jumia has rejected a listing for ──────────────────────────────────
--
-- lib/ai/restricted-words.ts holds the banned words we know of, and drafting
-- keeps them out three times over: the AI is told not to use them, they're
-- stripped after drafting, and stripped again right before a push
-- (lib/jumia/listing-ready.ts). But that list is fixed in code: "supreme"
-- and "second hand" only joined it after Jumia rejected listings for them
-- and someone added them by hand.
--
-- When a rejection names the word ("The Attribute [description] contains
-- the restricted words : supreme"), logFeedOutcome records it here, and
-- every later draft and push treats it exactly like the built-in list
-- (lib/jumia/learned-restricted-words.ts).
--
-- Server only: RLS on, no policies.

create table if not exists public.jumia_learned_restricted_words (
  word        text        primary key,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  -- The rejection it came from, for checking a word should really be here.
  example     text
);

alter table public.jumia_learned_restricted_words enable row level security;
