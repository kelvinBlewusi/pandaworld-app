-- The batch a seller just submitted in full (lib/whatsapp/intake.ts,
-- finishSubmittedBatch). While it's set the chat is idle after a submit:
-- only a clear new count or "Start another" begins a batch, and anything
-- else is told the products are already with Jumia. Live, 2026-10-02:
-- "Quantity 20" typed after a submit, meant for the submitted product,
-- started a new 20-product batch. Applied 2026-10-03.
alter table whatsapp_sessions add column if not exists last_submitted_batch_id text;
comment on column whatsapp_sessions.last_submitted_batch_id is
  'The batch the seller just submitted in full, while the chat waits for what is next. Set by the submit, cleared when a new batch starts or on restart. While set, only a clear new count or Start another begins a batch; other text is told the products are already with Jumia.';
