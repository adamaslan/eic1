-- EIC relay v3 admission hardening (LOCAL DRAFT). Applies AFTER hosted-self-enroll.sql.
-- NOT applied anywhere. Owner confirmation required before hosted installation.
-- Undo (manual): restore the v2 bodies of eic_relay_enroll (hosted-relay-v2-members.sql) and
--   eic_relay_admit_self (hosted-self-enroll.sql); alter table eic_relay.members drop column self_enrolled.
--
-- Two changes, both additive:
-- 1. Self-enrolled members may not vouch. One solved human check must not turn into a tree of
--    invites that fills the member cap.
-- 2. Vouched and self-enrolled admission share ONE advisory lock, so their cap checks cannot interleave.
begin;

alter table eic_relay.members add column if not exists self_enrolled boolean not null default false;

create or replace function public.eic_relay_enroll(p_pubkey text, p_inviter text, p_invite_id text) returns text
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
  if exists (select 1 from eic_relay.members where pubkey = p_inviter and self_enrolled) then
    return 'inviter_quota';
  end if;
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

create or replace function public.eic_relay_admit_self(p_pubkey text) returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare cfg eic_relay.config%rowtype;
begin
  perform pg_advisory_xact_lock(715241910);
  select * into cfg from eic_relay.config where id;
  if public.eic_relay_is_member(p_pubkey) then return 'member'; end if;
  if (select count(*) from eic_relay.members) >= cfg.max_members then return 'capacity'; end if;
  insert into eic_relay.members (pubkey, self_enrolled) values (p_pubkey, true);
  return 'enrolled';
end;
$$;

commit;
