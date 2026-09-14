-- Remember that a seller has already been shown the first-run welcome.
--
-- Deliberately NOT derived from linked_at. A seller who relinks — to fix a
-- glitch, or after switching phones — has not become a new user, and
-- replaying the tutorial at them would read as the system forgetting who
-- they are. Set once on the first link, never cleared.
--
-- Nullable with no default so every EXISTING connection reads as
-- not-yet-onboarded: the people already using this bot learned it without
-- a guide, and offering them one once is the right outcome, not a bug.

alter table whatsapp_connections
  add column if not exists onboarded_at timestamptz;

comment on column whatsapp_connections.onboarded_at is
  'When the first-run WhatsApp welcome was sent. Set once, never cleared — '
  'a relink is not a new user. Null means the welcome is still owed.';
