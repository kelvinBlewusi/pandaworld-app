-- A notice can also be shown at the dashboard's API-key card, above the Copy
-- button, until the seller copies their key (components/extension/
-- api-key-card.tsx): the one place a seller who was signed out of the
-- extension is sure to visit. First used for the Polish images notice.
alter table public.user_notices
  add column if not exists show_on_key_card boolean not null default false;
