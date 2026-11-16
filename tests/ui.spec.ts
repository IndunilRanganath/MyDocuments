// Browser interaction tests use a mocked transport; live RLS is tested separately.
import { test, expect } from '@playwright/test';
import { decrypt, decryptMeta, importMyDocumentsKey, newMyDocumentsKey, wrapKey } from '../lib/crypto';
test('mobile: unlock, encrypted upload, preview, rename, expiry, delete, and logout', async ({ page }) => {
  const raw = await newMyDocumentsKey(); const key = await importMyDocumentsKey(raw); const envelope = await wrapKey(raw,'123456');
  let docs: { id:string; encrypted_meta:string; created_at:string }[] = []; let uploaded: Buffer = Buffer.alloc(0); let intent: { id:string; encrypted_meta:string } | null = null;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname.slice(5); const method = req.method();
    let data: unknown = {ok:true};
    if (path === 'health') data = { configured:true };
    if (path === 'auth/login') data = { username:'alex', pin_envelope:envelope, recovery_envelope:null };
    if (path === 'documents' && method === 'GET') data = { documents:docs };
    if (path === 'documents/upload') { intent = req.postDataJSON(); data = { signedUrl:'http://127.0.0.1:3000/mock-upload' }; }
    if (path.endsWith('/complete')) { docs.push({ ...intent!, created_at:new Date().toISOString() }); }
    if (/^documents\/[^/]+$/.test(path)) {
      if (method === 'GET') data = { url:'http://127.0.0.1:3000/mock-download' };
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
  const date = new Date(); const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  await page.getByLabel(/Expiry date/).fill(today);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  await page.getByLabel('Choose document file').setInputFiles({name:'passport.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'Save document'}).click();
  await expect(page.getByRole('heading',{name:'My passport',exact:true})).toBeVisible();
  expect(uploaded.length).toBe(png.length+28);
  expect(Buffer.from(await decrypt(key,new Uint8Array(uploaded),`mydocuments:file:${docs[0].id}`))).toEqual(png);
  await expect(page.getByText('Expires today',{exact:true})).toBeVisible();
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
