-- find_unfinalized_settled_batches() matched by phone_number + session
-- state alone, so ANY settled analysis_jobs batch ever created for a phone
-- number was eligible — not just the one whatsapp_sessions.batch_id is
-- currently tracking.
--
-- Confirmed live, 2026-09-20: a seller drafted 20 products; the closing
-- summary they got back covered only 2. Sequence reconstructed from
-- Vercel logs + table state: an OLD batch (from an earlier "restart" that
-- abandoned it mid-flight, or an earlier miss by this same function before
-- this fix) had every one of its jobs sitting terminal ('done'/'failed')
-- but had never been finalized. The seller then started a brand new
-- 20-product batch, which flips whatsapp_sessions.state back to
-- 'analyzing' for the whole phone number — the OLD batch's row was never
-- touched by that, since jobs are looked up by phone_number, not by the
-- session's own batch_id. The next worker tick ran while the new 20-item
-- batch was still mid-flight (correctly excluded — it still had
-- queued/running jobs) but the stale 2-item batch matched "settled" on its
-- own and was the only row this function returned. closeSettledBatches
-- claimed it, sent "Done drafting your 2 products!", and flipped state to
-- 'awaiting_confirmation' — with the real batch not even close to done.
-- Once that happened, the 20-item batch could never be found again: this
-- function only ever looks at batches while state = 'analyzing', and
-- state had already moved on for a reason that had nothing to do with it.
--
-- The comment this replaced described the old "several backlogged batches,
-- most-recently-created wins" behaviour as intentional — the seller only
-- cares about the batch they're waiting on right now, not a days-old
-- abandoned one. This is that same intent, done correctly: pin the match
-- to whatsapp_sessions.batch_id, the one column that actually says which
-- batch the session is waiting on, instead of inferring it from
-- created_at. A batch that is no longer the session's active batch (e.g.
-- superseded by "restart") is exactly the abandoned case the old comment
-- meant to skip — now it can never be picked up again, which also means it
-- can never again hijack a later, unrelated cycle's finalization.
create or replace function find_unfinalized_settled_batches()
returns table (batch_id uuid, phone_number text, batch_size integer)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct on (aj.batch_id)
    aj.batch_id, aj.phone_number, aj.batch_size
  from analysis_jobs aj
  join whatsapp_sessions ws
    on ws.phone_number = aj.phone_number
   and ws.batch_id      = aj.batch_id
  where ws.state = 'analyzing'
    and not exists (
      select 1 from analysis_jobs aj2
      where aj2.batch_id = aj.batch_id
        and aj2.status in ('queued', 'running')
    )
  order by aj.batch_id;
$$;

revoke execute on function find_unfinalized_settled_batches() from public;
revoke execute on function find_unfinalized_settled_batches() from anon, authenticated;
grant  execute on function find_unfinalized_settled_batches() to service_role;
