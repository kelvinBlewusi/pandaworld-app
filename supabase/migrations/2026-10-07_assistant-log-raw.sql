-- The AI's own answer before our checks, kept with each assistant turn, to
-- see where it misreads (lib/whatsapp/assistant.ts; owner's live test,
-- 2026-10-07).
alter table public.whatsapp_assistant_log add column if not exists raw text;
comment on column public.whatsapp_assistant_log.raw is 'The AI''s own answer before our checks, to see where it misreads (lib/whatsapp/assistant.ts).';
