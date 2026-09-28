-- Jumia Self Authorization connections (lib/jumia/self-auth.ts).
--
-- Jumia issues refresh tokens only to "Self Authorization" applications;
-- "Web Application" apps (what sellers were told to create) never get one,
-- so their connection dies when the ~24 h access token expires and the
-- seller has to log in again. A Self Authorization connection is kept
-- alive by /api/worker/jumia-keepalive, which rotates the refresh token
-- before it lapses (refresh_token_expires_at, already on the table).

alter table public.jumia_connections
  add column if not exists auth_type text not null default 'web';

alter table public.jumia_connections
  drop constraint if exists jumia_connections_auth_type_check;
alter table public.jumia_connections
  add constraint jumia_connections_auth_type_check check (auth_type in ('web', 'self'));

comment on column public.jumia_connections.auth_type is
  'web = Jumia Web Application (OAuth login, no refresh token, expires daily); self = Self Authorization (refresh token rotated by /api/worker/jumia-keepalive).';

-- Every 30 minutes: renew connections close to expiry. Same vault-held
-- bearer secret as the other workers.
select cron.unschedule('jumia-keepalive') where exists (select 1 from cron.job where jobname = 'jumia-keepalive');
select cron.schedule(
  'jumia-keepalive',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/jumia-keepalive',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    )
  );
  $$
);
