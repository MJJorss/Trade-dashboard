/* Service worker — what makes the dashboard installable, and what lets it open
   with no signal.

   Everything is NETWORK FIRST. This is a trading dashboard: a fast answer that
   is an hour old is worse than a slow one that is current, so the cache is
   only ever a fallback for when the network fails, never a shortcut.

     the page itself        network first, cached copy when offline
     data files (/api/data) network first, last good copy when offline — the
                            response is marked so the page can say it is
                            showing saved data rather than pretending it is live
     /api/*                 never cached: a stale price is not a price
     fonts, icons           cache first — they never change under a URL

   Bump VERSION to drop every cached copy on the next visit. */

const VERSION = 'mj-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// The data URLs carry a ?t=<now> cache-buster, so every request is a new URL.
// Store and look up by the URL without its query, or nothing would ever match.
const bare = url => { const u = new URL(url); u.search = ''; return u.toString(); };

async function networkFirst(req, key, mark) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    if (!mark) return hit;
    const h = new Headers(hit.headers);
    h.set('x-mj-offline', '1');
    return new Response(await hit.blob(), { status: 200, headers: h });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Data files (worker.js /api/data/): network first, last good copy when
    // offline, marked so the page can say it is showing saved data.
    if (url.pathname.startsWith('/api/data/')) {
      e.respondWith(networkFirst(req, bare(req.url), true));
      return;
    }
    if (url.pathname.startsWith('/api/')) return;
    if (req.mode === 'navigate') {
      e.respondWith(networkFirst(req, '/', false));
      return;
    }
    if (url.pathname.startsWith('/icons/')) { e.respondWith(cacheFirst(req)); return; }
    return;
  }
  if (url.hostname === 'raw.githubusercontent.com') {
    e.respondWith(networkFirst(req, bare(req.url), true));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req));
  }
});
