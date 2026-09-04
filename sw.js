/* VÉLO Mar Menor — offline service worker
   Caches the app shell, your route data (manifest + FIT files), the map/FIT
   libraries, and map tiles you've viewed, so the hub works offline. */
const SHELL = 'velo-shell-v16';
const TILES = 'velo-tiles-v2';
const RUNTIME = 'velo-rt-v16';

const SHELL_URLS = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/vendor/leaflet.css',
  'assets/vendor/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@garmin/fitsdk/+esm',
  'https://cdn.jsdelivr.net/npm/pako@2/+esm',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/apple-touch-icon.png',
  'assets/hero-marmenor.jpg', 'assets/cabo-de-palos.jpg', 'assets/cartagena.jpg',
  'assets/la-manga.jpg', 'assets/santiago-ribera.jpg', 'assets/cycling.jpg', 'assets/coffee.jpg',
  'routes/manifest.json', 'routes/curated.json'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // cache shell items individually so one failure doesn't abort install
    await Promise.allSettled(SHELL_URLS.map(u => c.add(new Request(u, { cache: 'reload' }))));
    // cache every imported ride file so routes work offline
    try {
      const list = await (await fetch('routes/manifest.json', { cache: 'reload' })).json();
      await Promise.allSettled(list.map(it => c.add('routes/' + encodeURIComponent(it.file))));
    } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, TILES, RUNTIME];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live weather: always go to the network, never cache (stale forecasts are worse than none).
  if (url.hostname === 'api.open-meteo.com') return;

  // App navigations: network-first (fresh updates), fall back to cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(SHELL); c.put('index.html', res.clone());
        return res;
      } catch (_) {
        return (await caches.match('index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Route data (manifest + curated geometry): network-first so updates show, cache fallback offline.
  if (/routes\/(manifest|curated)\.json$/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(SHELL); c.put(req, res.clone());
        return res;
      } catch (_) { return (await caches.match(req)) || new Response('[]'); }
    })());
    return;
  }

  // Map tiles: cache-first into a dedicated tile cache (offline for viewed areas).
  if (/(arcgisonline\.com|cartocdn\.com|opentopomap\.org|openstreetmap\.(org|fr)|tile-cyclosm)/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); c.put(req, res.clone()); return res; }
      catch (_) { return hit || new Response('', { status: 504 }); }
    })());
    return;
  }

  // Everything else (shell, assets, FIT files, libs): cache-first, then network.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      const c = await caches.open(RUNTIME);
      try { c.put(req, res.clone()); } catch (_) {}
      return res;
    } catch (err) {
      return new Response('', { status: 504 });
    }
  })());
});
