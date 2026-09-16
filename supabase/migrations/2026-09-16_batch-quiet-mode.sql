-- Quiet batch mode: the seller sends every product's photos back to back,
-- closing each one by replying with just its number (or "done"), and gets
-- no reply at all until the LAST product's marker — at which point the
-- normal drafting flow (finalizeBatch, missing-price follow-up, submit
-- buttons) takes over exactly as it does today.
--
-- Offered as a CHOICE right after "how many products", alongside the
-- existing step-by-step flow — additive, not a replacement, so the
-- well-tested interactive path is completely unaffected for anyone who
-- doesn't pick this. Cleared on batch reset the same way pendingNotes and
-- awaiting_price_for already are — a mode choice belongs to the batch it
-- was made for, not the next one.
alter table public.whatsapp_sessions
  add column if not exists batch_quiet boolean not null default false;

comment on column public.whatsapp_sessions.batch_quiet is
  'True when the seller picked "just send it all" at the how-many-products '
  'step: no per-product confirmations, closed by replying with the '
  'product''s own number (or "done"). See handleQuietBatchText in '
  'lib/whatsapp/intake.ts.';
