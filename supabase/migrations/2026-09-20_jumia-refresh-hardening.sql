-- jumia_connections.status has carried the literal value 'needs_reconnect'
-- in application code (lib/jumia/api.ts's markNeedsReconnect) since that
-- function was introduced — but the table's ORIGINAL check constraint
-- (supabase/add_jumia_connections.sql) only ever allowed
-- 'active' | 'expired' | 'revoked'. Confirmed live, 2026-09-20: every
-- markNeedsReconnect() call has always been silently rejected by Postgres
-- and swallowed by code that never inspected the update's error — so
-- jumia_connections.status has NEVER actually recorded a dead connection,
-- for any seller, ever. All 15 real rows read 'active' regardless of
-- their actual token state. The "needs reconnect" experience sellers hit
-- has been coming entirely from the in-request JUMIA_RECONNECT_REQUIRED
-- exception, independent of this column.
alter table jumia_connections drop constraint if exists jumia_connections_status_check;
alter table jumia_connections add constraint jumia_connections_status_check
  check (status in ('active', 'expired', 'revoked', 'needs_reconnect'));

-- Jumia's refresh_token is long-lived (~1 year per Jumia's own docs) and
-- rotates on every successful refresh — this is for monitoring how close
-- a connection is to its TRUE end, not for driving a reconnect prompt off
-- the short-lived access token.
alter table jumia_connections add column if not exists refresh_token_expires_at timestamptz;

-- Single-flight lock for token refresh. The feed-poll cron, a page load's
-- connection health check, and an in-flight product push can all notice
-- the same expiring token at once. Jumia invalidates the previous
-- refresh_token on every successful rotation (its own documented "Refresh
-- Token Best Practices"), so two concurrent refreshes for the same
-- connection are not merely redundant — whichever one loses the race
-- persists a refresh_token Jumia has already thrown away, and the
-- following day's refresh permanently fails with no way back short of a
-- full reconnect. See claim_jumia_refresh_lock below and
-- refreshJumiaConnection in lib/jumia/api.ts.
alter table jumia_connections add column if not exists refresh_locked_at timestamptz;

-- Atomically claims the right to refresh one connection's token. Returns
-- the row if the caller won (nobody else holds the lock, or the last
-- holder never released it and has gone stale); returns nothing if
-- another caller is already mid-refresh. A plain application-level
-- read-then-write can't do this safely against PostgREST, which hands out
-- a different underlying connection per call — this has to be one atomic
-- statement.
create or replace function claim_jumia_refresh_lock(p_user_id text, p_stale_after interval default '30 seconds')
returns setof jumia_connections
language sql
set search_path = public, pg_temp
as $$
  update jumia_connections
  set refresh_locked_at = now()
  where user_id = p_user_id
    and (refresh_locked_at is null or refresh_locked_at < now() - p_stale_after)
  returning *;
$$;

revoke execute on function claim_jumia_refresh_lock(text, interval) from public;
revoke execute on function claim_jumia_refresh_lock(text, interval) from anon, authenticated;
grant  execute on function claim_jumia_refresh_lock(text, interval) to service_role;
