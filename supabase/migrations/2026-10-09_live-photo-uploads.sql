-- ─── Photos a seller sends to add to a live Jumia product ─────────────────────
--
-- "Add photos to the neck fan" (lib/whatsapp/live-photos.ts): the change is
-- kept in jumia_product_changes (status 'collecting') while its photos come
-- in, one row here per photo. A WhatsApp album arrives as several deliveries
-- at once, so each photo is its own insert rather than an append to one
-- row. On "done" they become the change's images and it's offered for its
-- tap. Service role only.

create table if not exists public.live_photo_uploads (
  id         bigserial primary key,
  change_id  uuid not null references public.jumia_product_changes (id) on delete cascade,
  user_id    text not null,
  url        text not null,
  created_at timestamptz not null default now()
);
create index if not exists live_photo_uploads_change_idx on public.live_photo_uploads (change_id, id);
alter table public.live_photo_uploads enable row level security;
