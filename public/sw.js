// Deliberately no caching: never persist documents, previews, API responses or PINs.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>MyDocuments</title><style>body{font:16px system-ui;padding:15vh 28px;background:#f8f9f6;color:#263e2c;text-align:center}button{padding:16px 24px;border:0;border-radius:12px;background:#436b50;color:white}</style><h1>MyDocuments is offline.</h1><p>Connect to unlock your documents.</p><a href="/">Try again</a>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
