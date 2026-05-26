-- listings.user_prompt — preserve the seller's free-text AI instruction
-- across the add → analyze → review → re-run lifecycle.
--
-- Why this migration:
--   On the add-product page the seller types "what do you want in the
--   listing" (e.g. "this is a pack of 6", "the colour is teal"). That
--   prompt currently gets sent ONCE on initial /auto-analyze and is
--   then lost — when the seller hits "Re-run AI" on the review page,
--   the input is empty and they have to remember what they typed.
--
--   By persisting the prompt on the listing row, we can:
--     1. Pre-fill the re-run input on the review page so re-runs honour
--        the same instructions the seller gave originally.
--     2. Always thread it into every subsequent auto-analyze pass, not
--        just the first one, so a seller who rebuilds an image still
--        gets a listing aligned to their original intent.
--     3. Show it in the activity feed / audit trail if we add one later.
--
-- Column is nullable + 1000-char capped — matches the userContext slice
-- already in lib/actions/ai.ts. No backfill needed; existing rows just
-- get NULL, which the UI handles as "empty prompt".
--
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent — re-running is a no-op.

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS user_prompt text;

COMMENT ON COLUMN listings.user_prompt IS
  'Free-text instruction the seller typed in the "What do you want in the listing" box. Threaded into every auto-analyze + refill-attributes pass for this listing. Capped at 1000 chars by app code. Used to ensure re-runs honour the original intent (e.g. "this is a pack of 6"). Nullable; older rows have NULL.';

-- Optional: light index for finding listings that have prompts. Used by
-- analytics queries ("how many sellers actually use the prompt box?")
-- but not by hot-path reads, so a partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_listings_with_user_prompt
  ON listings (created_at DESC)
  WHERE user_prompt IS NOT NULL;
