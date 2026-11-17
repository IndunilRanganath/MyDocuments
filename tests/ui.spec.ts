// Browser interaction tests use a mocked transport; live RLS is tested separately.
import { test, expect } from '@playwright/test';
import { decrypt, decryptMeta, encrypt, encryptMeta, importMyDocumentsKey, newMyDocumentsKey, wrapKey } from '../lib/crypto';
for (const mode of ['login', 'recover', 'signup'] as const) {
  test(`${mode}: opens with bundled documents and no follow-up list request`, async ({ page }) => {
    const raw = await newMyDocumentsKey(); const key = await importMyDocumentsKey(raw);
    const secret = mode === 'recover' ? 'a'.repeat(64) : '123456';
    const envelope = await wrapKey(raw, secret);
    const id = '11111111-1111-4111-8111-111111111111';
    const documents = mode === 'signup' ? [] : [{ id, created_at: new Date().toISOString(), encrypted_meta: await encryptMeta(key, { name: 'Existing passport', type: 'Passport', expiry: '', mime: 'image/png', filename: 'passport.png' }, id) }];
    let listRequests = 0;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/health') return route.fulfill({ json: { configured: true } });
      if (path === `/api/auth/${mode}`) return route.fulfill({ json: { username: 'alex', pin_envelope: envelope, recovery_envelope: mode === 'recover' ? envelope : null, documents } });
      if (path === '/api/documents') { listRequests++; return route.fulfill({ status: 500, json: { error: 'Unexpected list request' } }); }
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    if (mode === 'recover') await page.getByRole('button', { name: 'Forgot PIN?' }).click();
    if (mode === 'signup') await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Username or email').fill('alex');
    // Record any empty-state flash while existing documents are being decrypted.
    await page.evaluate(() => {
      document.body.dataset.sawEmpty = 'false';
      new MutationObserver(() => {
        if (document.querySelector('.empty-state')) document.body.dataset.sawEmpty = 'true';
      }).observe(document.body, { childList: true, subtree: true });
    });
    if (mode === 'recover') {
      await page.getByLabel('Recovery key').fill(secret);
      await page.getByRole('button', { name: 'Recover documents' }).click();
      await expect(page.getByRole('heading', { name: 'New PIN', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    } else {
      for (const n of secret) await page.getByRole('button', { name: n, exact: true }).click();
      if (mode === 'signup') {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        for (const n of secret) await page.getByRole('button', { name: n, exact: true }).click();
      }
      await page.getByRole('button', { name: mode === 'signup' ? 'Create account' : 'Unlock documents', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: /Your documents/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: mode === 'signup' ? 'No documents yet' : 'Existing passport', exact: true })).toBeVisible();
    if (mode !== 'signup') expect(await page.locator('body').getAttribute('data-saw-empty')).toBe('false');
    expect(listRequests).toBe(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  });
}
test('mobile: upload without expiry, preview, rename, delete, and logout', async ({ page }) => {
  const raw = await newMyDocumentsKey(); const key = await importMyDocumentsKey(raw); const envelope = await wrapKey(raw,'123456');
  let docs: { id:string; encrypted_meta:string; created_at:string }[] = []; let uploaded: Buffer = Buffer.alloc(0); let intent: { id:string; encrypted_meta:string } | null = null;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname.slice(5); const method = req.method();
    let data: unknown = {ok:true};
    if (path === 'health') data = { configured:true };
    if (path === 'auth/login') data = { username:'alex', pin_envelope:envelope, recovery_envelope:null, documents:docs };
    if (path === 'documents' && method === 'GET') data = { documents:docs };
    if (path === 'documents/upload') { intent = req.postDataJSON(); data = { signedUrl:new URL('/mock-upload', req.url()).href }; }
    if (path.endsWith('/complete')) { docs.push({ ...intent!, created_at:new Date().toISOString() }); }
    if (/^documents\/[^/]+$/.test(path)) {
      if (method === 'GET') data = { url:new URL('/mock-download', req.url()).href };
      if (method === 'PATCH') docs[0].encrypted_meta = req.postDataJSON().encrypted_meta;
      if (method === 'DELETE') docs = [];
    }
    await route.fulfill({ json:data });
  });
  await page.route('**/mock-upload', async route => { uploaded = route.request().postDataBuffer()!; await route.fulfill({json:{Key:'ok'}}); });
  await page.route('**/mock-download', route => route.fulfill({body:uploaded,contentType:'application/octet-stream'}));
  await page.goto('/');
  await page.getByLabel('Username or email').fill('alex');
  for (const n of '123456') await page.getByRole('button',{name:n,exact:true}).click();
  await page.getByRole('button',{name:'Unlock documents'}).click();
  await expect(page.getByRole('heading',{name:/Your documents/})).toBeVisible();
  await page.getByRole('button',{name:'Add document',exact:true}).click();
  await page.getByRole('textbox',{name:'Name',exact:true}).fill('My passport');
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  await page.getByLabel('Choose document file').setInputFiles({name:'passport.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'Save document'}).click();
  await expect(page.getByRole('heading',{name:'My passport',exact:true})).toBeVisible();
  expect(uploaded.length).toBe(png.length+28);
  expect(Buffer.from(await decrypt(key,new Uint8Array(uploaded),`mydocuments:file:${docs[0].id}`))).toEqual(png);
  expect((await decryptMeta(key, docs[0].encrypted_meta, docs[0].id)).expiry).toBe('');
  await page.getByRole('button',{name:/My passport Passport/}).click();
  await expect(page.getByAltText('My passport')).toBeVisible();
  await expect(page.getByRole('link',{name:'Download'})).toHaveAttribute('href',/^blob:/);
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  await page.getByLabel('Document name').fill('Travel passport');
  await page.getByRole('button',{name:'Save name'}).click();
  await expect(page.getByRole('heading',{name:'Travel passport'})).toBeVisible();
  expect((await decryptMeta(key,docs[0].encrypted_meta,docs[0].id)).name).toBe('Travel passport');
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByRole('button',{name:'Delete document',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No documents yet'})).toBeVisible();
  await page.getByRole('button',{name:'Open menu'}).click();
  await page.getByRole('menuitem',{name:'Log out'}).click();
  await expect(page.getByRole('button',{name:'Unlock documents'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for (const n of '123456') await page.getByRole('button',{name:n,exact:true}).click();
  await page.getByRole('button',{name:'Unlock documents'}).click();
  await expect(page.getByRole('heading',{name:/Your documents/})).toBeVisible();
  await page.clock.install(); await page.clock.fastForward(121000);
  await expect(page.getByRole('button',{name:'Unlock documents'})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('MyDocuments locked');
  expect(errors).toEqual([]);
});
test('signup requires matching PIN confirmation; dark layout fits desktop', async ({page}) => {
  await page.route('**/api/health',route=>route.fulfill({json:{configured:true}}));
  await page.emulateMedia({colorScheme:'dark'}); await page.setViewportSize({width:1280,height:900});
  await page.goto('/'); await page.getByRole('button',{name:'Create an account'}).click();
  await page.getByLabel('Username or email').fill('alex');
  for (const n of '123456') await page.getByRole('button',{name:n,exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByText('Confirm your 6-digit PIN')).toBeVisible();
  for (const n of '123455') await page.getByRole('button',{name:n,exact:true}).click();
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.locator('main').getByRole('alert')).toHaveText('PINs do not match. Try again.');
  expect(await page.locator('main').evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(480);
});

// Two pages with solid colors let us verify actual PDF pixels, not just a loaded iframe.
function coloredPdf() {
  const streams = ['1 0 0 rg 0 0 200 200 re f', '0 0 1 rg 0 0 200 200 re f'];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 6 0 R >>',
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('viewer: renders PDF pages, retries broken images, and ignores stale document requests', async ({ page }) => {
  const raw = await newMyDocumentsKey(); const key = await importMyDocumentsKey(raw); const envelope = await wrapKey(raw, '123456');
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const fixtures = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Photo', mime: 'image/png', bytes: png },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Two pages', mime: 'application/pdf', bytes: coloredPdf() },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Broken PDF', mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-invalid') },
  ];
  const docs = await Promise.all(fixtures.map(async item => ({ id: item.id, created_at: new Date().toISOString(), encrypted_meta: await encryptMeta(key, { name: item.name, type: 'Other', expiry: '', filename: item.name, mime: item.mime }, item.id) })));
  let photoDownloads = 0; let holdPhoto = false;
  let releasePhoto!: () => void; let photoStarted!: () => void;
  const held = new Promise<void>(resolve => { releasePhoto = resolve; });
  const started = new Promise<void>(resolve => { photoStarted = resolve; });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/health') return route.fulfill({ json: { configured: true } });
    if (path === '/api/auth/login') return route.fulfill({ json: { username: 'alex', pin_envelope: envelope, recovery_envelope: null, documents: docs } });
    const item = fixtures.find(item => path === `/api/documents/${item.id}`);
    if (item) {
      if (item.name === 'Photo' && holdPhoto) { photoStarted(); await held; }
      return route.fulfill({ json: { url: new URL(`/preview-file/${item.id}`, route.request().url()).href } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/preview-file/*', async route => {
    const item = fixtures.find(item => route.request().url().endsWith(item.id))!;
    const bytes = item.name === 'Photo' && ++photoDownloads === 1 ? new TextEncoder().encode('invalid image') : item.bytes;
    const encrypted = await encrypt(key, new Uint8Array(bytes).buffer, `mydocuments:file:${item.id}`);
    return route.fulfill({ body: Buffer.from(encrypted), contentType: 'application/octet-stream' });
  });
  await page.goto('/'); await page.getByLabel('Username or email').fill('alex');
  await page.getByLabel('Six-digit PIN').fill('123456'); await page.getByRole('button', { name: 'Unlock documents' }).click();
  await page.getByRole('button', { name: /Photo Other/ }).click();
  await expect(page.getByText('Preview unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /^blob:/);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.getByAltText('Photo').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: /Two pages Other/ }).click();
  const canvas = page.getByRole('img', { name: 'Two pages, page 1' });
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((el: HTMLCanvasElement) => Array.from(el.getContext('2d')!.getImageData(10, 10, 1, 1).data))).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: 'Next page' }).click();
  const second = page.getByRole('img', { name: 'Two pages, page 2' });
  await expect(second).toBeVisible();
  expect(await second.evaluate((el: HTMLCanvasElement) => Array.from(el.getContext('2d')!.getImageData(10, 10, 1, 1).data))).toEqual([0, 0, 255, 255]);
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: /Broken PDF Other/ }).click();
  await expect(page.getByText('Preview unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /^blob:/);
  await page.getByRole('button', { name: 'Back to documents' }).click();
  holdPhoto = true;
  await page.getByRole('button', { name: /Photo Other/ }).click(); await started;
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: /Two pages Other/ }).click();
  await expect(page.getByRole('img', { name: 'Two pages, page 1' })).toBeVisible();
  const lateResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${fixtures[0].id}`));
  releasePhoto(); await lateResponse;
  await expect(page.getByRole('img', { name: 'Two pages, page 1' })).toBeVisible();
  expect(photoDownloads).toBe(2);
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: 'Open menu' }).click(); await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});
