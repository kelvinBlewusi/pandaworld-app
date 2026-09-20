-- A settled analysis batch (every job either 'done' or 'failed', nothing
-- left 'queued' or 'running') that never got closed out for the seller.
--
-- Root cause: claim_analysis_jobs retires an exhausted job to 'failed'
-- itself, as a side effect of a claim attempt that finds attempts already
-- used up — that row is NEVER returned to the caller (only freshly-claimed
-- 'running' rows are, via the `claimed` CTE). app/api/worker/analyze-jobs
-- only ever checked isBatchSettled for the batch_ids of jobs it just
-- claimed THIS tick, so a batch whose LAST job settles this way — quietly,
-- inside the RPC, on a tick that hands back no claimable work at all — is
-- never checked again. Confirmed live: a single-product batch whose one
-- job hit Vercel's 60s function timeout three times in a row sat in
-- whatsapp_sessions.state = 'analyzing' indefinitely; the seller's
-- "drafting them now" message was the last thing they ever heard, with no
-- failure notice, no retry prompt, nothing.
--
-- Read-only, and both tables are already indexed on the columns this
-- joins/filters on (analysis_jobs.batch_id, whatsapp_sessions' primary
-- key), so it is cheap enough to call every worker tick — including one
-- that claimed no new work, which is exactly the tick where an orphaned
-- batch like this needs to be caught.
-- A single phone number only ever has one whatsapp_sessions row, so a
-- backlog of several never-finalized batches (each one a past "restart"
-- after getting stuck — confirmed live: 6 of them, one from a 20-product
-- batch) would all match "session still says analyzing" at once.
-- claimBatchFinalization's conditional UPDATE only lets the first one
-- processed actually send anything (it flips state off 'analyzing', so
-- every later one in the same tick loses that race and is silently
-- skipped, never retried once state has moved on) — ordering by most
-- recently created first makes sure that's the batch the seller is
-- actually waiting on right now, not a days-old abandoned one.
create or replace function find_unfinalized_settled_batches()
returns table (batch_id uuid, phone_number text, batch_size integer)
language sql
stable
set search_path = public, pg_temp
as $$
  select b.batch_id, b.phone_number, b.batch_size
  from (
    select distinct on (aj.batch_id)
      aj.batch_id, aj.phone_number, aj.batch_size, aj.created_at
    from analysis_jobs aj
    join whatsapp_sessions ws on ws.phone_number = aj.phone_number
    where ws.state = 'analyzing'
      and not exists (
        select 1 from analysis_jobs aj2
        where aj2.batch_id = aj.batch_id
          and aj2.status in ('queued', 'running')
      )
    order by aj.batch_id, aj.created_at desc
  ) b
  order by b.created_at desc;
$$;

-- Same posture as claim_analysis_jobs and every other function here:
-- createServerClient (service role) is the only intended caller.
revoke execute on function find_unfinalized_settled_batches() from public;
revoke execute on function find_unfinalized_settled_batches() from anon, authenticated;
grant  execute on function find_unfinalized_settled_batches() to service_role;
