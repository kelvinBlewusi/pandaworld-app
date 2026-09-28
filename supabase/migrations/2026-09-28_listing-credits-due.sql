-- Pay when live: WhatsApp and web listings are charged when Jumia confirms
-- them live, not when they're drafted. credits_due is what submitting the
-- listing promised to pay: set at submission while billing is on, charged
-- and cleared when the listing goes live, cleared without charge when the
-- submission fails. Pending listings' credits_due are held against the
-- seller's balance. See lib/billing/extension-credits.ts.

alter table public.listings add column if not exists credits_due numeric;

comment on column public.listings.credits_due is
  'Credits to charge when this listing goes live on Jumia (set at submission while billing is on). See lib/billing/extension-credits.ts.';
