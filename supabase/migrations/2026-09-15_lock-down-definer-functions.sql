-- Take SECURITY DEFINER functions away from anon and authenticated.
--
-- append_listing_image was shipped SECURITY DEFINER with EXECUTE left on
-- PUBLIC, which is the default. Every table here has RLS enabled with no
-- policies — a deliberate deny-all, since all application access goes
-- through the service role — but a SECURITY DEFINER function runs as its
-- OWNER and therefore straight past that. The anon key is public by
-- design (it ships in the browser), so the combination meant anyone could
-- POST to /rest/v1/rpc/append_listing_image with any listing UUID and
-- append an arbitrary image URL to a seller's product.
--
-- The function takes no ownership argument and checks none, because it
-- was written for a caller that had already proved ownership. That
-- assumption was true of the caller and false of the REST surface.
--
-- Revoked from PUBLIC *and* from anon/authenticated by name. Revoking
-- PUBLIC alone was tried first and changed nothing: Supabase grants these
-- two roles EXECUTE directly, so the named grants survive a PUBLIC
-- revoke. Verified after applying — anon and authenticated both read
-- false, service_role true.
--
-- service_role is what createServerClient uses, and is the only caller
-- these functions were ever meant to have.

revoke execute on function public.append_listing_image(uuid, text, integer) from public;
revoke execute on function public.append_listing_image(uuid, text, integer) from anon, authenticated;
grant  execute on function public.append_listing_image(uuid, text, integer) to service_role;

-- Same treatment: a maintenance helper with no business being reachable
-- from a browser.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public';
    execute 'revoke execute on function public.rls_auto_enable() from anon, authenticated';
    execute 'grant  execute on function public.rls_auto_enable() to service_role';
  end if;
end $$;

-- Pin the search_path on every function that lacked one. Without it a
-- caller can prepend a schema they control and have an unqualified name
-- inside the body resolve to their object instead of ours — the standard
-- SECURITY DEFINER escalation, and cheap to close whether or not anything
-- currently exploits it.
alter function public.update_updated_at()
  set search_path = public, pg_temp;
alter function public.claim_analysis_jobs(integer, interval, integer)
  set search_path = public, pg_temp;
alter function public.search_categories_by_embedding(vector, integer, text)
  set search_path = public, pg_temp;
alter function public.append_listing_image(uuid, text, integer)
  set search_path = public, pg_temp;
