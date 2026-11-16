import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
// Supabase clients run on the server. Keep the old public names as deployment fallbacks.
const supabaseUrl = () => process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = () => process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export function configured() { return Boolean(supabaseUrl() && supabaseAnonKey() && process.env.SUPABASE_SERVICE_ROLE_KEY && /^[a-f0-9]{64}$/i.test(process.env.APP_AUTH_SECRET || '') && process.env.APP_ORIGIN); }
export function client(admin = false) {
  if (!configured()) throw new HttpError(503, 'Connect Supabase to open your documents. See README.');
  return createClient(supabaseUrl()!, admin ? process.env.SUPABASE_SERVICE_ROLE_KEY! : supabaseAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
export function check(error: { message: string } | null) { if (error) { console.error('MyDocuments backend operation failed:', error.message); throw new HttpError(500, 'Could not complete this action. Please try again.'); } }
export function digest(value: string) { return createHmac('sha256', process.env.APP_AUTH_SECRET!).update(value).digest('hex'); }
export function authPassword(id: string) { return digest(`auth-password:${id}`); }
const cookieNames = () => process.env.NODE_ENV === 'production' ? ['__Host-mydocuments-access', '__Host-mydocuments-refresh'] : ['mydocuments-access', 'mydocuments-refresh'];
export async function setCookies(session: Session) {
  const jar = await cookies(); const names = cookieNames();
  for (const [i,value] of [session.access_token, session.refresh_token].entries()) jar.set(names[i], value, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 120 });
}
export async function clearCookies() { const jar = await cookies(); for (const name of cookieNames()) jar.set(name, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 }); }
export function sessionId(session: Session) { return z.uuid().parse(JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString()).session_id); }
export async function issueSession(id: string) {
  const admin = client(true);
  const identity = await admin.auth.admin.getUserById(id); check(identity.error);
  const email = `${id}@mydocuments.invalid`;
  // Existing identities retain their UUID, password and document ownership.
  if (identity.data.user?.email !== email) {
    check((await admin.auth.admin.updateUserById(id, { email, email_confirm: true })).error);
  }
  const sb = client(); const { data, error } = await sb.auth.signInWithPassword({ email, password: authPassword(id) }); check(error);
  if (!data.session) throw new HttpError(500, 'Could not start a session.');
  check((await client(true).from('mydocuments_sessions').insert({ id: sessionId(data.session), user_id: id, expires_at: new Date(Date.now() + 120000).toISOString() })).error);
  await setCookies(data.session);
  return sb;
}
export async function authenticated() {
  const jar = await cookies(); const names = cookieNames(); const access = jar.get(names[0])?.value; const refresh = jar.get(names[1])?.value;
  if (!access || !refresh) throw new HttpError(401, 'MyDocuments locked. Please sign in.');
  const sb = client();
  const { data: token, error: tokenError } = await sb.auth.setSession({ access_token: access, refresh_token: refresh });
  if (tokenError || !token.session) throw new HttpError(401, 'MyDocuments locked. Please sign in.');
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) throw new HttpError(401, 'MyDocuments locked. Please sign in.');
  const sid = sessionId(token.session);
  // Atomic update cannot revive an expired session, including a suspended mobile tab.
  const { data: active, error: activeError } = await client(true).from('mydocuments_sessions').update({ expires_at: new Date(Date.now() + 120000).toISOString() }).eq('id', sid).eq('user_id', user.id).gt('expires_at', new Date().toISOString()).select('id').maybeSingle();
  check(activeError); if (!active) throw new HttpError(401, 'MyDocuments locked. Please sign in.');
  await setCookies(token.session);
  return { sb, user, sid };
}
export function guard(request: Request) {
  const origin = process.env.APP_ORIGIN;
  if (process.env.NODE_ENV === 'production' && (!origin || !origin.startsWith('https://'))) throw new HttpError(503, 'Configure an HTTPS APP_ORIGIN.');
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) throw new HttpError(403, 'Request origin not allowed.');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Request origin not allowed.');
}
export async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Use JSON.');
  if (Number(request.headers.get('content-length')) > 16384) throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, 'Missing request.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16384) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); } chunks.push(part.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export async function rate(request: Request, scope: string, limit = 30, seconds = 900) {
  // Vercel overwrites x-vercel-forwarded-for. Outside Vercel configure a trusted proxy;
  // fallback is deliberately a shared limit, never an attacker-controlled header.
  const ip = process.env.VERCEL ? request.headers.get('x-vercel-forwarded-for') || 'unknown' : 'local';
  const { data, error } = await client(true).rpc('mydocuments_rate', { p_key: digest(`${scope}:${ip}`), p_limit: limit, p_seconds: seconds }); check(error);
  if (!data) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
}
export async function keys(sb: SupabaseClient, id: string) { const { data, error } = await sb.from('mydocuments_keys').select('pin_envelope,recovery_envelope').eq('user_id', id).single(); check(error); return data; }
export const username = z.string().trim().toLowerCase().min(3).max(120).regex(/^[a-z0-9][a-z0-9_.@+\-]*$/, 'Use letters, numbers, or an email.');
export const pin = z.string().regex(/^\d{6}$/, 'Enter a six-digit PIN.');
export const envelope = z.object({ v: z.literal(1), salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/), iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/), data: z.string().regex(/^[A-Za-z0-9+/]{64}$/) }).strict();
