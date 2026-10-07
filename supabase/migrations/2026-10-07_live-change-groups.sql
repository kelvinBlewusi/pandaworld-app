-- Several live products changed with one tap and one Jumia feed (owner's
-- second test, 2026-10-07: "set the boot and the freezer to 10" asked twice).
-- The rows of one such change share group_id; the confirm tap names the group
-- (lgrp:<group_id>) and every row gets the same feed_id.
alter table public.jumia_product_changes add column if not exists group_id uuid;
create index if not exists jumia_product_changes_group_idx on public.jumia_product_changes (group_id) where group_id is not null;

-- The assistant's daily allowance counts a seller's turns today
-- (lib/whatsapp/assistant-limits.ts).
create index if not exists whatsapp_assistant_log_user_day_idx on public.whatsapp_assistant_log (user_id, created_at desc);
create index if not exists whatsapp_assistant_log_day_idx on public.whatsapp_assistant_log (created_at desc);
