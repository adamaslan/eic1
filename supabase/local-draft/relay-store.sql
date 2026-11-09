-- LOCAL DRAFT ONLY. Never run against a hosted project without separate owner approval.
-- Requires independent review. No deployment, cron, TTL, ack or project setup is supplied.
-- Server-only RPCs: anon/authenticated cannot call them or read the private table.
begin;
create schema eic_relay;
revoke all on schema eic_relay from public, anon, authenticated;
create sequence eic_relay.generation_seq;
create table eic_relay.objects (
  key text collate "C" primary key check (length(key) between 1 and 1024),
  data text not null check (octet_length(data) <= 1100000),
  generation bigint not null default nextval('eic_relay.generation_seq'),
  updated_at timestamptz not null default now()
);
alter table eic_relay.objects enable row level security;
revoke all on all tables in schema eic_relay from public, anon, authenticated;
revoke all on all sequences in schema eic_relay from public, anon, authenticated;

create function public.eic_relay_get(p_key text) returns jsonb
language sql security definer set search_path = pg_catalog as $$
  select jsonb_build_object('data', data, 'generation', generation::text)
  from eic_relay.objects where key = p_key;
$$;

-- A single INSERT/UPDATE is the CAS linearization point. Global generations prevent ABA
-- when a key is deleted and re-created. Missing precondition returns NULL, never a retry loop.
create function public.eic_relay_cas(p_key text, p_data text, p_expected text) returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare result bigint;
begin
  if p_expected is null then
    insert into eic_relay.objects(key, data) values (p_key, p_data)
    on conflict (key) do nothing returning generation into result;
  else
    update eic_relay.objects set data = p_data,
      generation = nextval('eic_relay.generation_seq'), updated_at = now()
    where key = p_key and generation::text = p_expected returning generation into result;
  end if;
  return result::text;
end;
$$;

-- Retries of identical immutable bytes succeed; conflicting bytes never overwrite an object.
create function public.eic_relay_put(p_key text, p_data text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare stored text;
begin
  insert into eic_relay.objects(key, data) values (p_key, p_data) on conflict(key) do nothing;
  select data into stored from eic_relay.objects where key = p_key;
  if stored is distinct from p_data then raise exception 'Immutable relay object conflict'; end if;
end;
$$;

-- Literal prefix, not LIKE: '_' and '%' cannot broaden the selection.
-- Cursor compares key values instead of looking up a possibly deleted cursor row.
create function public.eic_relay_list(p_prefix text, p_cursor text, p_limit integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare result jsonb;
begin
  if p_limit < 1 or p_limit > 1000 or p_limit is null then raise exception 'Invalid limit'; end if;
  with page as (
    select key from eic_relay.objects where starts_with(key, p_prefix)
      and (p_cursor is null or key > p_cursor collate "C") order by key limit p_limit + 1
  ), visible as (select key from page order by key limit p_limit)
  select jsonb_build_object('keys', coalesce((select jsonb_agg(key order by key) from visible), '[]'::jsonb))
    || case when (select count(*) from page) > p_limit
      then jsonb_build_object('nextCursor', (select max(key) from visible)) else '{}'::jsonb end
  into result;
  return result;
end;
$$;
create function public.eic_relay_delete(p_key text) returns void
language sql security definer set search_path = pg_catalog as $$
  delete from eic_relay.objects where key = p_key;
$$;
revoke all on function public.eic_relay_get(text), public.eic_relay_cas(text,text,text),
 public.eic_relay_put(text,text), public.eic_relay_list(text,text,integer), public.eic_relay_delete(text)
 from public, anon, authenticated;
grant execute on function public.eic_relay_get(text), public.eic_relay_cas(text,text,text),
 public.eic_relay_put(text,text), public.eic_relay_list(text,text,integer), public.eic_relay_delete(text)
 to service_role;
commit;
