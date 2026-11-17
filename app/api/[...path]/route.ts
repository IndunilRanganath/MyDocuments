import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticated, check, clearCookies, client, configured, documents, envelope, guard, HttpError, issueSession, keys, pin, rate, readBody, username, authPassword, unlockData } from '@/lib/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache' } });
const meta = z.string().min(40).max(8192).regex(/^[A-Za-z0-9+/]+=*$/);
const recovery = z.string().regex(/^[a-f0-9]{64}$/);
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    guard(request);
    const { path } = await context.params; const action = path.join('/'); const method = request.method;
    if (action === 'health' && method === 'GET') return json({ configured: configured() });
    if (action === 'auth/signup' && method === 'POST') {
      await rate(request, 'signup', 5, 900);
      const b = z.object({ username, pin, confirmPin: pin, envelope }).parse(await readBody(request));
      if (b.pin !== b.confirmPin) throw new HttpError(400, 'PINs do not match.');
      const id = randomUUID(); const admin = client(true);
      const { error } = await admin.auth.admin.createUser({ id, email: `${id}@mydocuments.invalid`, password: authPassword(id), email_confirm: true }); check(error);
      const result = await admin.rpc('mydocuments_register', { p_id: id, p_username: b.username, p_pin: b.pin, p_envelope: b.envelope });
      if (result.error) { await admin.auth.admin.deleteUser(id); throw new HttpError(409, 'Account could not be created. Try another username.'); }
      const sb = await issueSession(id); return json({ ...(await keys(sb, id)), documents: [], username: b.username }, 201);
    }
    if ((action === 'auth/login' || action === 'auth/recover') && method === 'POST') {
      await rate(request, 'login');
      const isRecovery = action === 'auth/recover';
      const b = z.object({ username, secret: isRecovery ? recovery : pin }).parse(await readBody(request));
      const { data: id, error } = await client(true).rpc('mydocuments_verify', { p_username: b.username, p_secret: b.secret, p_recovery: isRecovery }); check(error);
      if (!id) throw new HttpError(400, 'Details incorrect or account locked. After 5 attempts, wait 15 minutes.');
      const sb = await issueSession(id); return json({ ...(await unlockData(sb, id)), username: b.username });
    }
    if (action === 'auth/logout' && method === 'POST') {
      try { const { sb, sid } = await authenticated(); check((await client(true).from('mydocuments_sessions').delete().eq('id', sid)).error); await sb.auth.signOut({ scope: 'local' }); }
      catch (error) { if (!(error instanceof HttpError && error.status === 401)) throw error; }
      finally { await clearCookies(); }
      return json({ ok: true });
    }
    const { sb, user, sid } = await authenticated();
    if (action === 'session' && method === 'POST') return json({ ok: true });
    if (action === 'settings/recovery' && method === 'POST') {
      const b = z.object({ secret: recovery, envelope }).parse(await readBody(request));
      check((await client(true).rpc('mydocuments_set_recovery', { p_id: user.id, p_secret: b.secret, p_envelope: b.envelope })).error);
      return json({ ok: true });
    }
    if (action === 'settings/pin' && method === 'POST') {
      const b = z.object({ pin, confirmPin: pin, envelope }).parse(await readBody(request));
      if (b.pin !== b.confirmPin) throw new HttpError(400, 'PINs do not match.');
      check((await client(true).rpc('mydocuments_reset_pin', { p_id: user.id, p_pin: b.pin, p_envelope: b.envelope })).error);
      await clearCookies(); return json({ ok: true });
    }
    if (action === 'documents' && method === 'GET') {
      return json({ documents: await documents(sb) });
    }
    if (action === 'documents/upload' && method === 'POST') {
      const b = z.object({ id: z.uuid(), encrypted_meta: meta, ciphertext_size: z.number().int().min(29).max(10485788) }).parse(await readBody(request));
      const storagePath = `${user.id}/${b.id}.bin`;
      check((await sb.from('documents').insert({ ...b, user_id: user.id, storage_path: storagePath })).error);
      const { data, error } = await sb.storage.from('documents').createSignedUploadUrl(storagePath);
      if (error) { await sb.from('documents').delete().eq('id', b.id); check(error); }
      return json({ signedUrl: data!.signedUrl });
    }
    if (path[0] === 'documents' && path[1]) {
      const id = z.uuid().parse(path[1]);
      const { data: doc, error } = await sb.from('documents').select('*').eq('id', id).single();
      if (error || !doc) throw new HttpError(404, 'Document not found.');
      if (path[2] === 'complete' && method === 'POST') {
        const { data: info, error: infoError } = await sb.storage.from('documents').info(doc.storage_path); check(infoError);
        if (info?.size !== doc.ciphertext_size) throw new HttpError(400, 'Upload incomplete. Please try again.');
        check((await sb.from('documents').update({ ready: true }).eq('id', id)).error); return json({ ok: true });
      }
      if (path.length === 2 && method === 'GET' && doc.ready) {
        const { data, error: downloadError } = await sb.storage.from('documents').createSignedUrl(doc.storage_path, 15); check(downloadError); return json({ url: data!.signedUrl });
      }
      if (path.length === 2 && method === 'PATCH') {
        const b = z.object({ encrypted_meta: meta }).parse(await readBody(request));
        check((await sb.from('documents').update(b).eq('id', id)).error); return json({ ok: true });
      }
      if (path.length === 2 && method === 'DELETE') {
        check((await sb.storage.from('documents').remove([doc.storage_path])).error);
        check((await sb.from('documents').delete().eq('id', id)).error); return json({ ok: true });
      }
    }
    void sid;
    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues[0]?.message || 'Check your entries.' }, 400);
    if (error instanceof HttpError) { if (error.status === 401) await clearCookies(); return json({ error: error.message }, error.status); }
    console.error('Unexpected MyDocuments error', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
