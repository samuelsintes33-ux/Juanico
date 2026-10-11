'use strict';
/* service-worker.js — caché para que la app funcione sin conexión.
   Al publicar cambios, sube VERSION para que los teléfonos descarguen los archivos nuevos.
   La actualización NO se activa sola: el usuario pulsa «Buscar actualización» en Configuración. */
const VERSION = '1.2.0';
const CACHE = `almacen-cache-v${VERSION}`;
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './database.js', './inventory.js', './categories.js',
  './gallery.js', './lists.js', './settings.js', './sync.js', './cart.js', './manifest.json', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('almacen-cache-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const home = await caches.match('./index.html');
        if (home) return home;
      }
      return new Response('Sin conexión', { status: 503, statusText: 'Sin conexión' });
    }
  })());
});
