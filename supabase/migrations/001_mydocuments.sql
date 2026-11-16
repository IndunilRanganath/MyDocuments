-- Run once in a fresh Supabase project. No client has access to PIN hashes.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists mydocuments_private;
revoke all on schema mydocuments_private from public, anon, authenticated;
create table mydocuments_private.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username = lower(username) and length(username) between 3 and 120),
  pin_hash text not null,
  recovery_hash text,
  failures integer not null default 0,
  locked_until timestamptz
);
create table mydocuments_private.rate_limits (key text primary key, hits int not null, reset_at timestamptz not null);
create table public.mydocuments_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index on public.mydocuments_sessions(expires_at);
alter table public.mydocuments_sessions enable row level security;
-- No direct client policies: only server service-role maintenance.
revoke all on public.mydocuments_sessions from anon, authenticated;
create function public.mydocuments_active() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mydocuments_sessions where id::text = auth.jwt()->>'session_id' and user_id = auth.uid() and expires_at > now());
$$;
revoke all on function public.mydocuments_active() from public, anon;
grant execute on function public.mydocuments_active() to authenticated;
create table public.mydocuments_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_envelope jsonb not null,
  recovery_envelope jsonb,
  created_at timestamptz not null default now()
);
alter table public.mydocuments_keys enable row level security;
create policy keys_read on public.mydocuments_keys for select to authenticated using (user_id = (select auth.uid()) and (select public.mydocuments_active()));
grant select on public.mydocuments_keys to authenticated;
revoke insert, update, delete on public.mydocuments_keys from anon, authenticated;
create table public.documents (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  encrypted_meta text not null check (length(encrypted_meta) between 40 and 8192),
  storage_path text not null unique,
  ciphertext_size integer not null check (ciphertext_size between 29 and 10485788),
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  check (storage_path = user_id::text || '/' || id::text || '.bin')
);
create index on public.documents(user_id, created_at desc);
alter table public.documents enable row level security;
create policy documents_owner on public.documents for all to authenticated using (user_id = (select auth.uid()) and (select public.mydocuments_active())) with check (user_id = (select auth.uid()) and (select public.mydocuments_active()));
grant select, insert, update, delete on public.documents to authenticated;
revoke all on public.documents from anon;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485788, array['application/octet-stream']);
create policy files_read on storage.objects for select to authenticated using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.mydocuments_active()));
create policy files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.mydocuments_active())
  and exists(select 1 from public.documents d where d.storage_path = name and not d.ready)
);
create policy files_delete on storage.objects for delete to authenticated using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.mydocuments_active()));
-- Atomic per-account bcrypt verification + lockout. Row locking serializes concurrent guesses.
create function public.mydocuments_verify(p_username text, p_secret text, p_recovery boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a mydocuments_private.accounts%rowtype; h text;
begin
  select * into a from mydocuments_private.accounts where username = lower(p_username) for update;
  if not found then
    perform extensions.crypt(p_secret, '$2a$12$abcdefghijklmnopqrstuu');
    return null;
  end if;
  if a.locked_until > now() then return null; end if;
  if a.locked_until is not null then a.failures := 0; end if;
  h := case when p_recovery then a.recovery_hash else a.pin_hash end;
  if h is not null and extensions.crypt(p_secret, h) = h then
    update mydocuments_private.accounts set failures = 0, locked_until = null where user_id = a.user_id;
    return a.user_id;
  end if;
  update mydocuments_private.accounts set failures = a.failures + 1,
    locked_until = case when a.failures + 1 >= 5 then now() + interval '15 minutes' else null end
    where user_id = a.user_id;
  return null;
end;
$$;
create function public.mydocuments_register(p_id uuid, p_username text, p_pin text, p_envelope jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_pin !~ '^[0-9]{6}$' then raise exception 'Invalid PIN'; end if;
  insert into mydocuments_private.accounts(user_id,username,pin_hash) values (p_id,lower(p_username),extensions.crypt(p_pin,extensions.gen_salt('bf',12)));
  insert into public.mydocuments_keys(user_id,pin_envelope) values (p_id,p_envelope);
end;
$$;
create function public.mydocuments_set_recovery(p_id uuid, p_secret text, p_envelope jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_secret !~ '^[a-f0-9]{64}$' then raise exception 'Invalid recovery key'; end if;
  update mydocuments_private.accounts set recovery_hash = extensions.crypt(p_secret,extensions.gen_salt('bf',12)) where user_id=p_id;
  update public.mydocuments_keys set recovery_envelope=p_envelope where user_id=p_id;
end;
$$;
create function public.mydocuments_reset_pin(p_id uuid, p_pin text, p_envelope jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_pin !~ '^[0-9]{6}$' then raise exception 'Invalid PIN'; end if;
  update mydocuments_private.accounts set pin_hash=extensions.crypt(p_pin,extensions.gen_salt('bf',12)), failures=0, locked_until=null where user_id=p_id;
  update public.mydocuments_keys set pin_envelope=p_envelope where user_id=p_id;
  delete from public.mydocuments_sessions where user_id=p_id;
end;
$$;
create function public.mydocuments_rate(p_key text, p_limit int, p_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into mydocuments_private.rate_limits(key,hits,reset_at) values(p_key,1,now()+make_interval(secs=>p_seconds))
  on conflict(key) do update set hits=case when mydocuments_private.rate_limits.reset_at <= now() then 1 else mydocuments_private.rate_limits.hits+1 end,
    reset_at=case when mydocuments_private.rate_limits.reset_at <= now() then now()+make_interval(secs=>p_seconds) else mydocuments_private.rate_limits.reset_at end
  returning hits into n;
  return n <= p_limit;
end;
$$;
-- Explicit function allowlist. SECURITY DEFINER functions never remain PUBLIC executable.
revoke all on function public.mydocuments_verify(text,text,boolean), public.mydocuments_register(uuid,text,text,jsonb), public.mydocuments_set_recovery(uuid,text,jsonb), public.mydocuments_reset_pin(uuid,text,jsonb), public.mydocuments_rate(text,int,int) from public, anon, authenticated;
grant execute on function public.mydocuments_verify(text,text,boolean), public.mydocuments_register(uuid,text,text,jsonb), public.mydocuments_set_recovery(uuid,text,jsonb), public.mydocuments_reset_pin(uuid,text,jsonb), public.mydocuments_rate(text,int,int) to service_role;
grant all on public.mydocuments_keys, public.mydocuments_sessions to service_role;
