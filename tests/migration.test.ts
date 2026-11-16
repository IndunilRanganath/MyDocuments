import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { legacyEncryptionContext } from '../lib/legacy-compat';
const fresh = readFileSync('supabase/migrations/001_mydocuments.sql','utf8')
  .replace('create extension if not exists pgcrypto with schema extensions;','');
const upgrade = readFileSync('supabase/migrations/002_mydocuments_rename.sql','utf8');
const previous = legacyEncryptionContext('mydocuments:')!.slice(0,-1);
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '44444444-4444-4444-8444-444444444444';
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, storage to authenticated;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid,name text,bucket_id text);
    alter table storage.objects enable row level security;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    -- Test-only stand-ins: bcrypt correctness is covered by the live Supabase test.
    -- This local test exercises real Postgres DDL, function bodies, grants and RLS.
    create function extensions.gen_salt(text,int) returns text language sql as $$ select 'test'::text $$;
    create function extensions.crypt(secret text,salt text) returns text language sql as $$ select 'test:' || secret $$;
  `);
  return db;
}
async function asUser(db: PGlite, id: string, session: string) {
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,session_id:session})]);
  await db.exec('set role authenticated');
}
test('database rename keeps records, function access, RLS ownership, and idle expiry', async () => {
  const db = await database();
  try {
    await db.exec(fresh.replaceAll('mydocuments',previous));
    await db.query('insert into auth.users(id) values($1),($2)',[userA,userB]);
    for (const [id,name] of [[userA,'alice'],[userB,'bob']]) {
      await db.query(`select public.${previous}_register($1,$2,'135790',$3::jsonb)`,[id,name,JSON.stringify({v:1,data:'existing encrypted key'})]);
    }
    await db.query(`insert into public.${previous}_sessions(id,user_id,expires_at) values($1,$2,now()+interval '2 minutes'),($3,$4,now()+interval '2 minutes')`,[sessionA,userA,sessionB,userB]);
    const docId = '55555555-5555-4555-8555-555555555555'; const objectPath = `${userA}/${docId}.bin`;
    await db.query('insert into public.documents(id,user_id,encrypted_meta,storage_path,ciphertext_size) values($1,$2,$3,$4,29)',[docId,userA,'a'.repeat(60),objectPath]);
    await db.query("insert into storage.objects(id,name,bucket_id) values($1,$2,'documents')",[docId,objectPath]);
    await db.exec(upgrade);
    // Repeat safely without recreating or duplicating anything.
    await db.exec(upgrade);
    assert.equal((await db.query('select * from mydocuments_private.accounts')).rows.length,2);
    assert.equal((await db.query('select * from public.mydocuments_keys')).rows.length,2);
    assert.equal((await db.query('select * from public.documents')).rows.length,1);
    assert.equal((await db.query<{id:string | null}>('select public.mydocuments_verify($1,$2) as id',['alice','135790'])).rows[0]?.id,userA);
    const old = await db.query("select proname from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname like $1",[`${previous}_%`]);
    assert.equal(old.rows.length,0);
    await asUser(db,userA,sessionA);
    assert.equal((await db.query('select * from public.mydocuments_keys')).rows.length,1);
    assert.equal((await db.query('select * from public.documents')).rows.length,1);
    assert.equal((await db.query('select * from storage.objects')).rows.length,1);
    await assert.rejects(db.query("select public.mydocuments_verify('alice','135790')"),/permission denied/);
    await db.exec('reset role'); await asUser(db,userB,sessionB);
    assert.equal((await db.query('select * from public.documents')).rows.length,0);
    assert.equal((await db.query('select * from storage.objects')).rows.length,0);
    await db.exec('reset role');
    await db.query("update public.mydocuments_sessions set expires_at=now()-interval '1 second' where id=$1",[sessionA]);
    await asUser(db,userA,sessionA);
    assert.equal((await db.query('select * from public.mydocuments_keys')).rows.length,0);
    assert.equal((await db.query('select * from public.documents')).rows.length,0);
    assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  } finally { await db.close(); }
});
test('fresh database accepts the renamed schema and upgrade is a no-op', async () => {
  const db = await database();
  try {
    await db.exec(fresh); await db.exec(upgrade);
    assert.equal((await db.query<{name:string | null}>("select to_regclass('public.mydocuments_keys') as name")).rows[0]?.name,'mydocuments_keys');
  } finally { await db.close(); }
});
