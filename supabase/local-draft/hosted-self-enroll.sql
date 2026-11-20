-- EIC relay self-enrollment (LOCAL DRAFT). Applies after hosted-relay-v2-members.sql.
-- NOT applied anywhere. Owner confirmation required before hosted installation.
-- Undo (manual): drop function public.eic_relay_admit_self(text), public.eic_relay_claim_self_enroll(integer);
--   drop table eic_relay.self_enroll_daily; alter table eic_relay.config drop column self_enroll_per_day.
-- The Turnstile secret is NOT stored here. It is an Edge Function secret (TURNSTILE_SECRET_KEY) set in the
-- Supabase dashboard, never in SQL, the client or the repo.
begin;

-- Global daily budget for self-enrollments. 0 disables self-enrollment in the database as well.
alter table eic_relay.config
  add column self_enroll_per_day integer not null default 25 check (self_enroll_per_day between 0 and 10000);

create table eic_relay.self_enroll_daily (
  day date primary key,
  claimed integer not null default 0 check (claimed >= 0)
);
alter table eic_relay.self_enroll_daily enable row level security;
revoke all on eic_relay.self_enroll_daily from public, anon, authenticated, service_role;

-- Atomic claim: the row is updated only while under the limit, so concurrent requests cannot overspend.
create function public.eic_relay_claim_self_enroll(p_limit integer) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
declare ok boolean;
begin
  insert into eic_relay.self_enroll_daily (day, claimed) values (current_date, 1)
    on conflict (day) do update set claimed = eic_relay.self_enroll_daily.claimed + 1
    where eic_relay.self_enroll_daily.claimed < p_limit;
  ok := found;
  return ok;
end
$$;

-- Capped insert. Locks the config row so the member count and the insert cannot interleave.
create function public.eic_relay_admit_self(p_pubkey text) returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare cap integer;
begin
  if exists (select 1 from eic_relay.members where pubkey = p_pubkey)
     or exists (select 1 from eic_relay.config where id and p_pubkey = any(public_keys)) then
    return 'member';
  end if;
  select max_members into cap from eic_relay.config where id for update;
  if (select count(*) from eic_relay.members) >= cap then return 'capacity'; end if;
  insert into eic_relay.members (pubkey) values (p_pubkey);
  return 'enrolled';
end
$$;

revoke all on function public.eic_relay_claim_self_enroll(integer) from public, anon, authenticated;
revoke all on function public.eic_relay_admit_self(text) from public, anon, authenticated;
grant execute on function public.eic_relay_claim_self_enroll(integer) to service_role;
grant execute on function public.eic_relay_admit_self(text) to service_role;
commit;
