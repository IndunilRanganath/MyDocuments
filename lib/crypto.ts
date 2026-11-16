import { legacyEncryptionContext } from './legacy-compat';
// Versioned envelopes. All decrypted content and CryptoKeys stay in memory.
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const ITERATIONS = 600_000;
export type Envelope = { v: 1; salt: string; iv: string; data: string };
export type DocType = 'Passport' | 'ID' | 'Visa' | 'Other';
export type Metadata = { name: string; type: DocType; expiry: string; mime: string; filename: string };
const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function derive(secret: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function newMyDocumentsKey() { return crypto.getRandomValues(new Uint8Array(32)); }
export async function wrapKey(raw: Uint8Array<ArrayBuffer>, secret: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(secret, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('mydocuments:key:v1') }, key, raw);
  return { v: 1, salt: base64(salt), iv: base64(iv), data: base64(new Uint8Array(data)) };
}
export async function unwrapKey(envelope: Envelope, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.v !== 1) throw new Error('Unsupported encryption version.');
  const key = await derive(secret, unbase64(envelope.salt));
  return new Uint8Array(await decryptWithContext(key, unbase64(envelope.data), unbase64(envelope.iv), 'mydocuments:key:v1'));
}
export async function importMyDocumentsKey(raw: Uint8Array<ArrayBuffer>) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function encrypt(key: CryptoKey, data: ArrayBuffer, context: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, data);
  const packed = new Uint8Array(12 + result.byteLength); packed.set(iv); packed.set(new Uint8Array(result), 12); return packed;
}
export async function decrypt(key: CryptoKey, packed: Uint8Array<ArrayBuffer>, context: string) {
  return decryptWithContext(key, packed.slice(12), packed.slice(0, 12), context);
}
async function decryptWithContext(key: CryptoKey, ciphertext: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, context: string): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, ciphertext);
  } catch (error) {
    const previous = legacyEncryptionContext(context);
    if (!previous) throw error;
    // Retains the document UUID and payload kind; cross-document swaps still fail.
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(previous) }, key, ciphertext);
  }
}
export async function encryptMeta(key: CryptoKey, meta: Metadata, id: string) { return base64(await encrypt(key, encoder.encode(JSON.stringify(meta)).buffer, `mydocuments:meta:${id}`)); }
export async function decryptMeta(key: CryptoKey, data: string, id: string): Promise<Metadata> {
  return JSON.parse(new TextDecoder().decode(await decrypt(key, unbase64(data), `mydocuments:meta:${id}`)));
}
export async function validateFile(file: File) {
  if (!file.size || file.size > MAX_FILE_SIZE) throw new Error('Choose a file up to 10 MB.');
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const png = [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v);
  const pdf = new TextDecoder().decode(b.slice(0,5)) === '%PDF-';
  const mime = jpeg ? 'image/jpeg' : png ? 'image/png' : pdf ? 'application/pdf' : '';
  if (!mime || (file.type && file.type !== mime)) throw new Error('Choose a JPG, PNG, or PDF.');
  return mime;
}
export function daysUntil(date: string, today = new Date()) {
  if (!date) return null;
  const [y,m,d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y,m-1,d) - Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())) / 86400000);
}
export function recoverySecret() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
