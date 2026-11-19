-- EIC hosted relay v2: vouched enrollment + per-publisher cap. Applies on top of
-- hosted-relay.sql. Additive and non-destructive: no rows deleted, no table dropped.
-- NOT applied anywhere. Owner confirmation required before hosted installation.
-- Undo (manual): drop function public.eic_relay_enroll(text,text,text),
--   public.eic_relay_is_member(text); drop table eic_relay.members; restore the v1
--   enforce_capacity body from hosted-relay.sql; drop the added config columns.
begin;

-- Quotas live here so the owner can tune them with one UPDATE, no redeploy.
-- Proposed values, UNCONFIRMED: 1000 members, 10 vouches per member, 3 uses per
-- invite link, 200 rows / 4 MiB per publisher feed.
alter table eic_relay.config
  add column max_members integer not null default 1000 check (max_members between 1 and 100000),
  add column invites_per_member integer not null default 10 check (invites_per_member between 0 and 1000),
  add column uses_per_invite integer not null default 3 check (uses_per_invite between 1 and 1000),
  add column feed_max_rows integer not null default 200 check (feed_max_rows between 3 and 10000),
  add column feed_max_bytes bigint not null default 4194304 check (feed_max_bytes between 4096 and 33554432);

create table eic_relay.members (
  pubkey text collate "C" primary key check (octet_length(pubkey) between 1 and 128),
  -- NULL for roots seeded from config.public_keys. No FK: a manual-override key in
  -- config.public_keys may vouch without a members row.
  inviter text collate "C" check (inviter is null or octet_length(inviter) between 1 and 128),
  invite_id text collate "C" check (invite_id is null or invite_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  enrolled_at timestamptz not null default now(),
  check ((inviter is null) = (invite_id is null))
);
create index members_inviter_idx on eic_relay.members (inviter, invite_id);
alter table eic_relay.members enable row level security;
revoke all on eic_relay.members from public, anon, authenticated, service_role;

-- Existing admitted keys become roots. config.public_keys stays as the manual override.
insert into eic_relay.members (pubkey)
  select distinct unnest(public_keys) from eic_relay.config where id
  on conflict (pubkey) do nothing;

create function public.eic_relay_is_member(p_pubkey text) returns boolean
language sql stable security definer set search_path = pg_catalog as $$
  select exists (select 1 from eic_relay.members where pubkey = p_pubkey)
    or exists (select 1 from eic_relay.config where id and p_pubkey = any(public_keys));
$$;

-- One lock serializes enrollments so the counts below cannot be raced past.
-- Denials are returned as values (the Edge maps them to 403); only outages raise.
create function public.eic_relay_enroll(p_pubkey text, p_inviter text, p_invite_id text) returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare cfg eic_relay.config%rowtype;
begin
  if p_pubkey is null or octet_length(p_pubkey) not between 1 and 128
    or p_inviter is null or octet_length(p_inviter) not between 1 and 128
    or p_invite_id is null or p_invite_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'Invalid enrollment';
  end if;
  perform pg_advisory_xact_lock(715241910);
  select * into cfg from eic_relay.config where id;
  if public.eic_relay_is_member(p_pubkey) then return 'member'; end if;
  if not public.eic_relay_is_member(p_inviter) then return 'inviter_not_member'; end if;
  if (select count(*) from eic_relay.members where inviter = p_inviter and invite_id = p_invite_id) >= cfg.uses_per_invite then
    return 'invite_used';
  end if;
  if (select count(*) from eic_relay.members where inviter = p_inviter) >= cfg.invites_per_member then
    return 'inviter_quota';
  end if;
  if (select count(*) from eic_relay.members) >= cfg.max_members then return 'capacity'; end if;
  insert into eic_relay.members (pubkey, inviter, invite_id) values (p_pubkey, p_inviter, p_invite_id);
  return 'enrolled';
end;
$$;

revoke all on function public.eic_relay_is_member(text), public.eic_relay_enroll(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.eic_relay_is_member(text), public.eic_relay_enroll(text,text,text)
  to service_role;

-- v1 body plus one block: a per-publisher cap on feeds/<hash>/ so one enrolled key
-- cannot fill the global 10,000-row / 32 MiB cap for everyone. The state object is
-- under the same prefix and is UPDATEd in place, which never adds a row.
create or replace function eic_relay.enforce_capacity() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare used_bytes bigint; used_rows bigint; reader_rows bigint; reader_prefix text; recent_reads bigint;
  feed_prefix text; feed_rows bigint; feed_bytes bigint; cfg eic_relay.config%rowtype;
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
  if starts_with(NEW.key,'feeds/') then
    if split_part(NEW.key,'/',2) !~ '^[a-z2-7]{52}$' then raise exception 'Invalid publisher namespace'; end if;
    select * into cfg from eic_relay.config where id;
    feed_prefix := 'feeds/'||split_part(NEW.key,'/',2)||'/';
    select count(*),coalesce(sum(octet_length(data)+octet_length(key)+128),0)
      into feed_rows,feed_bytes from eic_relay.objects where starts_with(key,feed_prefix);
    if TG_OP='UPDATE' then
      feed_bytes := feed_bytes-octet_length(OLD.data)-octet_length(OLD.key)-128;
      feed_rows := feed_rows-1;
    end if;
    if feed_rows+1>cfg.feed_max_rows or feed_bytes+new_bytes>cfg.feed_max_bytes then
      raise exception 'Publisher capacity reached';
    end if;
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
commit;
