-- EIC Discover directory state (LOCAL DRAFT). Applies after hosted-relay-v2-members.sql.
-- NOT applied anywhere. Owner confirmation required before hosted installation.
-- Undo (manual): drop function public.eic_relay_directory_read(), public.eic_relay_directory_cas(text, jsonb);
--   drop table eic_relay.directory_state.
begin;

create table eic_relay.directory_state (
  id integer primary key check (id = 1),
  generation text not null,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table eic_relay.directory_state enable row level security;
revoke all on eic_relay.directory_state from public, anon, authenticated, service_role;
insert into eic_relay.directory_state (id, generation, value)
  values (1, '0', '{"cards":{},"requests":{},"actors":{}}') on conflict (id) do nothing;

create function public.eic_relay_directory_read() returns jsonb
language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object('generation', generation, 'value', value) from eic_relay.directory_state where id = 1
$$;

-- Compare-and-set: writes only when the caller read the current generation. Size-capped.
create function public.eic_relay_directory_cas(p_generation text, p_value jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
declare ok boolean;
begin
  if octet_length(p_value::text) > 4194304 then raise exception 'Directory is full'; end if;
  update eic_relay.directory_state
     set generation = (generation::bigint + 1)::text, value = p_value, updated_at = now()
   where id = 1 and generation = p_generation;
  ok := found;
  return ok;
end
$$;

revoke all on function public.eic_relay_directory_read() from public, anon, authenticated;
revoke all on function public.eic_relay_directory_cas(text, jsonb) from public, anon, authenticated;
grant execute on function public.eic_relay_directory_read() to service_role;
grant execute on function public.eic_relay_directory_cas(text, jsonb) to service_role;
commit;
