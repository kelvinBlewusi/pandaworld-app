-- ─── Drafts whose category the AI wasn't sure of ──────────────────────────
--
-- When the drafting pass isn't sure of a product's category, the bot sends
-- "🤔 … not sure of product N's category" with alternates to tap. Until
-- 2026-10-01 a typed answer ("Educational Tablets", "1 category: …") was
-- read as chit-chat and got the generic help, and every reply sent while
-- the rest of the batch was still drafting got "hang tight".
--
-- The flag marks which drafts are waiting on that answer, so a typed
-- category name can be matched to the product it's for. It lives on the
-- listing, not the session: up to three workers draft a batch at once,
-- and a per-listing write can't lose another worker's update.
-- lib/whatsapp/intake.ts sets it with the message and clears it when the
-- category is switched; a submitted listing is never a draft, so a stale
-- flag is never read.
alter table public.listings
  add column if not exists category_unsure boolean not null default false;
