/* Service Worker · Materiales SAP – Plan Infra
 * Guarda la "carcasa" de la app para que abra sin conexión. Los envíos al servidor nunca se responden desde caché. */
const VERSION = 'ms-v1';
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Red primero (recibe actualizaciones); caché si no hay conexión.
  e.respondWith(fetch(req).then((resp) => {
    const copia = resp.clone();
    caches.open(VERSION).then((c) => c.put(req, copia));
    return resp;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
