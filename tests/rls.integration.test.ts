// Opt-in only. Creates two disposable accounts in your configured Supabase project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const enabled = process.env.MYDOCUMENTS_RUN_INTEGRATION === 'true';
test('live database: atomic lockout, private storage, owner RLS, and idle expiry', { skip: !enabled }, async () => {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)!;
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession:false } });
  const ids: string[] = []; const paths: string[] = [];
  const ok = (r: { error: unknown }) => assert.equal(r.error, null);
  try {
    async function account() {
      const id = randomUUID(); const username = `test-${id}`; const password = randomUUID() + randomUUID();
      ok(await admin.auth.admin.createUser({ id, email: `${id}@mydocuments.invalid`, password, email_confirm:true })); ids.push(id);
      ok(await admin.rpc('mydocuments_register', { p_id:id, p_username:username, p_pin:'135790', p_envelope:{ v:1 } }));
      const sb = createClient(url, anonKey, { auth: { persistSession:false, autoRefreshToken:false } });
      const login = await sb.auth.signInWithPassword({ email:`${id}@mydocuments.invalid`, password }); ok(login);
      const sid = JSON.parse(Buffer.from(login.data.session!.access_token.split('.')[1], 'base64url').toString()).session_id;
      ok(await admin.from('mydocuments_sessions').insert({ id:sid, user_id:id, expires_at:new Date(Date.now()+120000).toISOString() }));
      return { id, sb, sid, username };
    }
    const a = await account(); const b = await account();
    const doc = randomUUID(); const path = `${a.id}/${doc}.bin`; paths.push(path);
    ok(await a.sb.from('documents').insert({ id:doc, user_id:a.id, encrypted_meta:'a'.repeat(60), storage_path:path, ciphertext_size:29 }));
    assert.equal((await b.sb.from('documents').select().eq('id',doc)).data?.length,0);
    assert.ok((await b.sb.from('documents').insert({ id:randomUUID(), user_id:a.id, encrypted_meta:'a'.repeat(60), storage_path:path, ciphertext_size:29 })).error);
    ok(await a.sb.storage.from('documents').upload(path,new Uint8Array(29),{ contentType:'application/octet-stream' }));
    assert.ok((await b.sb.storage.from('documents').download(path)).error);
    const stranger = createClient(url,anonKey,{auth:{persistSession:false}});
    assert.ok((await stranger.storage.from('documents').download(path)).error);
    ok(await a.sb.storage.from('documents').download(path));
    assert.equal((await admin.rpc('mydocuments_verify',{p_username:a.username,p_secret:'135790'})).data,a.id);
    // Parallel guesses must serialize and exhaust one shared five-attempt allowance.
    const guesses = await Promise.all(Array.from({length:5},()=>admin.rpc('mydocuments_verify',{p_username:a.username,p_secret:'000000'})));
    guesses.forEach(r => { ok(r); assert.equal(r.data,null); });
    assert.equal((await admin.rpc('mydocuments_verify',{p_username:a.username,p_secret:'135790'})).data,null);
    ok(await admin.from('mydocuments_sessions').update({ expires_at:new Date(Date.now()-1000).toISOString() }).eq('id',a.sid));
    assert.equal((await a.sb.from('documents').select()).data?.length,0);
    assert.ok((await a.sb.storage.from('documents').download(path)).error);
    assert.equal((await a.sb.from('mydocuments_keys').select()).data?.length,0);
  } finally {
    if (paths.length) await admin.storage.from('documents').remove(paths);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  }
});
