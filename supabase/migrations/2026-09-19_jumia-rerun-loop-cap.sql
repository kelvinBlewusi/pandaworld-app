-- Cap automatic Jumia rejection repair to one attempt per error shape.
--
-- Real production loop, 2026-09-17/18: a listing rejected with "You can't
-- list products in this category" kept getting "Fix & resubmit" -> redraft
-- -> resubmit -> the identical rejection, repeatedly over more than an
-- hour, with no message ever telling the seller the automatic fix wasn't
-- working. handleFixAndResubmit (lib/whatsapp/intake.ts) now records the
-- shape of the last automatic attempt here, and refuses a second automatic
-- attempt at the SAME shape — see shouldBlockRepeatedAutoFix in
-- lib/jumia/rejection-remedy.ts.
alter table public.listings
  add column if not exists jumia_rerun_fingerprint text,
  add column if not exists jumia_rerun_count integer not null default 0;

comment on column public.listings.jumia_rerun_fingerprint is
  'rejectionFingerprint() of the last automatic Fix & resubmit attempt on '
  'this listing. Null once a push succeeds or the seller is handed back '
  'the problem. See lib/jumia/rejection-remedy.ts.';

comment on column public.listings.jumia_rerun_count is
  'How many consecutive automatic attempts have matched '
  'jumia_rerun_fingerprint. Capped at one before handing back to the '
  'seller — see shouldBlockRepeatedAutoFix.';
