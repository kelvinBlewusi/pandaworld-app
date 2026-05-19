-- Add image_variants JSONB column to listings.
--
-- The column stores Gemini-enhanced versions of each original image
-- without overwriting listings.images. Shape:
--
--   {
--     "<originalUrl>": { "polish": "<enhancedUrl>", "rebuild": "<enhancedUrl>" },
--     ...
--   }
--
-- Lets sellers compare before/after and accept/reject per image — and
-- means re-opening the EnhanceModal doesn't re-burn Gemini calls (we
-- reuse cached variants).
--
-- Apply via the Supabase SQL editor or `supabase db push` once you've
-- linked the local CLI.

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS image_variants jsonb;

COMMENT ON COLUMN listings.image_variants IS
  'Per-image enhancement cache: { originalUrl: { polish?, rebuild? } }. Written by /api/enhance-images; read by the EnhanceModal to show before/after.';
