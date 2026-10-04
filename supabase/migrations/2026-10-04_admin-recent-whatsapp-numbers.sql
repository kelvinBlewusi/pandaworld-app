-- Every number in the WhatsApp message log, latest activity first, for the
-- admin messages page (app/admin/messages/page.tsx). The page used to take
-- the latest 500 rows and list the numbers in them, so a number that had
-- gone quiet for 500 messages dropped off (2026-10-04: 5 numbers, 4 shown).
-- Service role only: phone numbers are personal data.

create or replace function public.admin_recent_whatsapp_numbers(p_limit integer default 100)
returns table (phone_number text, last_activity timestamptz, messages bigint)
language sql
stable
set search_path = public
as $$
  select l.phone_number, max(l.created_at) as last_activity, count(*) as messages
  from public.whatsapp_message_log l
  group by l.phone_number
  order by max(l.created_at) desc
  limit greatest(1, least(p_limit, 500));
$$;

revoke execute on function public.admin_recent_whatsapp_numbers(integer) from public, anon, authenticated;
grant execute on function public.admin_recent_whatsapp_numbers(integer) to service_role;
