-- EIC initial hosted relay schema. Non-destructive, fail on conflicting objects.
-- Storage is capped and fails closed. No historical-data cleanup is included.
-- Server-only RPCs: anon/authenticated cannot call them or read the private table.
begin;
create schema eic_relay;
revoke all on schema eic_relay from public, anon, authenticated, service_role;
create sequence eic_relay.generation_seq;
create table eic_relay.objects (
  key text collate "C" primary key check (octet_length(key) between 1 and 1024),
  data text not null check (octet_length(data) <= 1100000),
  generation bigint not null default nextval('eic_relay.generation_seq'),
  updated_at timestamptz not null default now()
);
alter table eic_relay.objects enable row level security;
revoke all on all tables in schema eic_relay from public, anon, authenticated, service_role;
revoke all on all sequences in schema eic_relay from public, anon, authenticated, service_role;

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
 from public, anon, authenticated, service_role;
grant execute on function public.eic_relay_get(text), public.eic_relay_cas(text,text,text),
 public.eic_relay_put(text,text), public.eic_relay_list(text,text,integer), public.eic_relay_delete(text)
 to service_role;
-- All object writes serialize admission under one transaction-scoped lock. Limits
-- include nonce/state/immutable rows; cannot be bypassed by concurrent publishers.
-- Expired signed-read nonces are reclaimed inline before a limit refuses a write, so
-- an all-expired namespace or a full table cannot wedge the relay. A nonce is
-- reclaimed only after its signed timestamp is more than 10 minutes old, which is
-- beyond the 5-minute read freshness window the Edge gate enforces, so a reclaimed
-- nonce can never be replayed. The 10-minute horizon also absorbs DB/Edge clock skew.
create function eic_relay.enforce_capacity() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare used_bytes bigint; used_rows bigint; reader_rows bigint; reader_prefix text; recent_reads bigint;
  new_bytes bigint := octet_length(NEW.data)+octet_length(NEW.key)+128;
begin
  perform pg_advisory_xact_lock(715241909);
  if TG_OP='INSERT' and exists(select 1 from eic_relay.objects where key=NEW.key) then return NEW; end if;
  if starts_with(NEW.key,'replay/') then
    if split_part(NEW.key,'/',2) !~ '^[a-z2-7]{52}$' then raise exception 'Invalid reader namespace'; end if;
    reader_prefix := 'replay/'||split_part(NEW.key,'/',2)||'/';
    select count(*) into reader_rows from eic_relay.objects where starts_with(key,reader_prefix);
    if reader_rows>=1200 then
      delete from eic_relay.objects where key in (
        select key from eic_relay.objects where starts_with(key,reader_prefix) and key<>NEW.key
          and case when data ~ '^[0-9]+(\.[0-9]+)?$' then abs(extract(epoch from now())*1000 - data::numeric) > 600000 else false end limit 500);
      select count(*) into reader_rows from eic_relay.objects where starts_with(key,reader_prefix);
    end if;
    select count(*) into recent_reads from eic_relay.objects where starts_with(key,reader_prefix) and updated_at>now()-interval '1 minute';
    if recent_reads>=120 and TG_OP='INSERT' then raise exception 'Reader rate reached'; end if;
    if reader_rows>=1200 and TG_OP='INSERT' then raise exception 'Reader capacity reached'; end if;
  end if;
  select coalesce(sum(octet_length(data)+octet_length(key)+128),0),count(*)
    into used_bytes,used_rows from eic_relay.objects;
  if TG_OP='UPDATE' then
    used_bytes := used_bytes-octet_length(OLD.data)-octet_length(OLD.key)-128;
    used_rows := used_rows-1;
  end if;
  if used_rows+1>10000 or used_bytes+new_bytes>33554432 then
    delete from eic_relay.objects where key in (
      select key from eic_relay.objects where starts_with(key,'replay/') and key<>NEW.key
        and case when data ~ '^[0-9]+(\.[0-9]+)?$' then abs(extract(epoch from now())*1000 - data::numeric) > 600000 else false end limit 1000);
    select coalesce(sum(octet_length(data)+octet_length(key)+128),0),count(*)
      into used_bytes,used_rows from eic_relay.objects;
    if TG_OP='UPDATE' then
      used_bytes := used_bytes-octet_length(OLD.data)-octet_length(OLD.key)-128;
      used_rows := used_rows-1;
    end if;
    if used_rows+1>10000 or used_bytes+new_bytes>33554432 then
      raise exception 'Relay capacity reached';
    end if;
  end if;
  return NEW;
end;
$$;
revoke all on function eic_relay.enforce_capacity() from public,anon,authenticated,service_role;
create trigger relay_capacity before insert or update on eic_relay.objects
  for each row execute function eic_relay.enforce_capacity();
create table eic_relay.config (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 public_keys text[] not null default '{}',
 origins text[] not null default '{}'
);
alter table eic_relay.config enable row level security;
revoke all on eic_relay.config from public,anon,authenticated,service_role;
insert into eic_relay.config(id) values(true);
create function public.eic_relay_config() returns jsonb
language sql security definer set search_path=pg_catalog as $$
 select jsonb_build_object('enabled',enabled,'keys',public_keys,'origins',origins) from eic_relay.config where id=true;
$$;
revoke all on function public.eic_relay_config() from public,anon,authenticated;
grant execute on function public.eic_relay_config() to service_role;
comment on schema eic_relay is 'EIC signed encrypted chat relay; no direct browser access';
commit;
