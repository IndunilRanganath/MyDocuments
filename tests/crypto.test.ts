import test from 'node:test';
import { legacyEncryptionContext } from '../lib/legacy-compat';
import assert from 'node:assert/strict';
import { daysUntil, decrypt, encrypt, encryptMeta, decryptMeta, importMyDocumentsKey, MAX_FILE_SIZE, newMyDocumentsKey, unwrapKey, validateFile, wrapKey } from '../lib/crypto';
test('PIN and recovery envelopes independently unlock the same document key', async () => {
  const raw = await newMyDocumentsKey(); const envelope = await wrapKey(raw, '123456');
  assert.deepEqual(await unwrapKey(envelope, '123456'), raw);
  await assert.rejects(unwrapKey(envelope, '654321'));
  const recovery = await wrapKey(raw, 'a'.repeat(64));
  assert.deepEqual(await unwrapKey(recovery, 'a'.repeat(64)), raw);
});
test('ciphertext rejects tampering, wrong keys, and document substitution', async () => {
  const key = await importMyDocumentsKey(await newMyDocumentsKey()); const wrong = await importMyDocumentsKey(await newMyDocumentsKey());
  const plain = new TextEncoder().encode('sensitive passport');
  const encrypted = await encrypt(key, plain.buffer, 'mydocuments:file:first');
  assert.deepEqual(new Uint8Array(await decrypt(key, encrypted, 'mydocuments:file:first')), plain);
  assert.equal(encrypted.length, plain.length + 28);
  await assert.rejects(decrypt(key, encrypted, 'mydocuments:file:second'));
  await assert.rejects(decrypt(wrong, encrypted, 'mydocuments:file:first'));
  encrypted[15] ^= 1;
  await assert.rejects(decrypt(key, encrypted, 'mydocuments:file:first'));
});
test('document names and expiry dates round trip only with the key', async () => {
  const key = await importMyDocumentsKey(await newMyDocumentsKey());
  const meta = { name: 'Private passport', type: 'Passport' as const, expiry: '2030-12-01', mime:'image/jpeg', filename: 'passport.jpg' };
  const encrypted = await encryptMeta(key, meta, 'id');
  assert.ok(!encrypted.includes('passport'));
  assert.deepEqual(await decryptMeta(key, encrypted, 'id'), meta);
  await assert.rejects(decryptMeta(key, encrypted, 'another-id'));
});
test('file validation checks signatures, MIME mismatch, emptiness and the 10 MB boundary', async () => {
  assert.equal(await validateFile(new File(['%PDF-1.7\n'], 'a.pdf', { type: 'application/pdf' })), 'application/pdf');
  assert.equal(await validateFile(new File([new Uint8Array([255,216,255,0])], 'a.jpg', { type: 'image/jpeg' })), 'image/jpeg');
  assert.equal(await validateFile(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'a.png', { type: 'image/png' })), 'image/png');
  await assert.rejects(validateFile(new File(['<script>'], 'a.jpg', { type: 'image/jpeg' })));
  await assert.rejects(validateFile(new File(['%PDF-1.7'], 'a.jpg', { type: 'image/jpeg' })));
  await assert.rejects(validateFile(new File([], 'a.pdf')));
  const large = new Uint8Array(MAX_FILE_SIZE + 1); large.set(new TextEncoder().encode('%PDF-'));
  await assert.rejects(validateFile(new File([large], 'a.pdf')));
  assert.equal(await validateFile(new File([large.slice(0, MAX_FILE_SIZE)], 'a.pdf')), 'application/pdf');
});
test('expiry includes today and day 90, using calendar days', () => {
  const today = new Date(2026, 0, 1, 23, 59);
  assert.equal(daysUntil('', today), null); assert.equal(daysUntil('2026-01-01', today), 0);
  assert.equal(daysUntil('2026-04-01', today), 90); assert.equal(daysUntil('2025-12-31', today), -1);
});

test('existing encrypted files, metadata and key envelopes survive the product rename', async () => {
  const raw = await newMyDocumentsKey(); const key = await importMyDocumentsKey(raw);
  const text = new TextEncoder().encode('existing document');
  const previousFile = await encrypt(key,text.buffer,legacyEncryptionContext('mydocuments:file:existing')!);
  assert.deepEqual(new Uint8Array(await decrypt(key,previousFile,'mydocuments:file:existing')),text);
  await assert.rejects(decrypt(key,previousFile,'mydocuments:file:another'));
  await assert.rejects(decrypt(key,previousFile,'mydocuments:meta:existing'));
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw',new TextEncoder().encode('123456'),'PBKDF2',false,['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},material,{name:'AES-GCM',length:256},false,['encrypt']);
  const oldWrapped = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(legacyEncryptionContext('mydocuments:key:v1')!)},wrappingKey,raw);
  const b64 = (v: Uint8Array) => Buffer.from(v).toString('base64');
  const oldEnvelope = {v:1 as const,salt:b64(salt),iv:b64(iv),data:b64(new Uint8Array(oldWrapped))};
  assert.deepEqual(await unwrapKey(oldEnvelope,'123456'),raw);
  await assert.rejects(unwrapKey(oldEnvelope,'654321'));
  const meta = {name:'Existing passport',type:'Passport' as const,expiry:'',mime:'image/png',filename:'old.png'};
  const oldMeta = await encrypt(key,new TextEncoder().encode(JSON.stringify(meta)).buffer,legacyEncryptionContext('mydocuments:meta:existing')!);
  assert.deepEqual(await decryptMeta(key,b64(oldMeta),'existing'),meta);
});
