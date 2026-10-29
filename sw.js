/* VÉLO Mar Menor — offline service worker
   Caches the app shell, your route data (manifest + FIT files), the map/FIT
   libraries, and map tiles you've viewed, so the hub works offline. */
const SHELL = 'velo-shell-v27';
const TILES = 'velo-tiles-v2';
const RUNTIME = 'velo-rt-v27';

const SHELL_URLS = [
  './', 'index.html', 'coach.html', 'assets/coach-engine.js', 'manifest.webmanifest',
  'assets/vendor/leaflet.css',
  'assets/vendor/leaflet.js', 'assets/vendor/supabase.js', 'assets/velo-config.js',
  'https://cdn.jsdelivr.net/npm/@garmin/fitsdk/+esm',
  'https://cdn.jsdelivr.net/npm/pako@2/+esm',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/apple-touch-icon.png',
  'assets/hero-boats.jpg', 'assets/hero-bike.jpg', 'assets/hero-marmenor.jpg', 'assets/cabo-de-palos.jpg', 'assets/cartagena.jpg',
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

  // Live weather + Supabase (suggestions/auth) + the coach's intervals.icu bridge: always network, never cache.
  if (url.hostname === 'api.open-meteo.com' || url.hostname.endsWith('supabase.co')) return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // App navigations: network-first (fresh updates), fall back to the cached page offline.
  // Each page is cached under its own key so the coach page never replaces the hub (and vice versa).
  if (req.mode === 'navigate') {
    const isCoach = /\/coach(\.html)?$/.test(url.pathname);
    const isHub = url.pathname === '/' || /\/index\.html$/.test(url.pathname);
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (isCoach || isHub)) { const c = await caches.open(SHELL); c.put(isCoach ? 'coach.html' : 'index.html', res.clone()); }
        return res;
      } catch (_) {
        if (isCoach) { const hit = await caches.match('coach.html'); if (hit) return hit; }
        return (await caches.match('index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Coach engine: network-first so plan logic updates straight away, cached copy offline.
  if (url.origin === self.location.origin && /\/assets\/coach-/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(SHELL); c.put(req, res.clone());
        return res;
      } catch (_) { return (await caches.match(req)) || new Response('', { status: 504 }); }
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
