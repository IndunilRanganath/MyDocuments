-- Existing installations: run this once instead of rerunning migration 001.
-- Fresh installations already use the new names; this migration is then a no-op.
-- Historical names below identify existing objects, not new application objects.
begin;
do $migration$
declare
  item record;
  definition text;
begin
  if to_regnamespace('vault_private') is null then
    if to_regnamespace('mydocuments_private') is not null then return; end if;
    raise exception 'Install migration 001_mydocuments.sql first';
  end if;
  if to_regnamespace('mydocuments_private') is not null then
    raise exception 'Both old and new schemas exist; resolve the conflict before upgrading';
  end if;
  alter schema vault_private rename to mydocuments_private;
  alter table public.vault_sessions rename to mydocuments_sessions;
  alter table public.vault_keys rename to mydocuments_keys;

  -- Rename the same function objects so existing RLS dependencies and grants survive.
  for item in
    select p.oid, p.proname, p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('vault_active','vault_verify','vault_register','vault_set_recovery','vault_reset_pin','vault_rate')
  loop
    execute format('alter function %s rename to %I', item.signature, replace(item.proname,'vault_','mydocuments_'));
    select pg_get_functiondef(item.oid) into definition;
    -- Stored PL/pgSQL/SQL bodies contain textual references which ALTER does not rewrite.
    execute replace(definition,'vault_','mydocuments_');
  end loop;

  for item in
    select c.conname, c.conrelid::regclass as table_name
    from pg_constraint c
    where c.conrelid in ('public.mydocuments_sessions'::regclass,'public.mydocuments_keys'::regclass)
      and position('vault' in c.conname) > 0
  loop
    execute format('alter table %s rename constraint %I to %I',item.table_name,item.conname,replace(item.conname,'vault','mydocuments'));
  end loop;
  for item in
    select schemaname,indexname from pg_indexes
    where schemaname='public' and tablename in ('mydocuments_sessions','mydocuments_keys')
      and position('vault' in indexname) > 0
  loop
    execute format('alter index %I.%I rename to %I',item.schemaname,item.indexname,replace(item.indexname,'vault','mydocuments'));
  end loop;
end
$migration$;
notify pgrst, 'reload schema';
commit;
