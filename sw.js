/* WC·26 service worker — offline support without ever trapping an online user on stale code.
 *
 * Strategy:
 *   - HTML / app.js / styles.css / *.json  → NETWORK-FIRST: always fresh when online; the cached
 *     copy is only used as an offline fallback. (Co-operates with the in-app version-refresh nudge.)
 *   - flags / icons / images / fonts        → CACHE-FIRST: immutable-ish, fast, fine offline.
 * Cache keys strip ?t= / ?v= so the every-60s polled files and versioned assets don't pile up.
 * Bump CACHE per deploy; activate() purges old caches and claims clients.
 */
const CACHE = "wc26-329";
const keyFor = req => new Request(new URL(req.url).origin + new URL(req.url).pathname); // drop the query

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => e.waitUntil((async () => {
  const old = (await caches.keys()).filter(k => k !== CACHE);
  for (const k of old) await caches.delete(k);
  await self.clients.claim();
  // A real update (not first install): old caches are purged. Force every open page to reload onto the fresh
  // build. This lives in the WORKER, which the browser always replaces — so it rescues even a tab still running
  // an older app.js (whose in-page pill can't). Loop-safe: only fires when an older cache was just purged, so a
  // later activation is a no-op. Message first as a fallback for browsers where navigate() is blocked.
  if (old.length) for (const c of await self.clients.matchAll({ type: "window" })) {
    c.postMessage({ type: "wc26-updated" });
    try { await c.navigate(c.url); } catch { /* navigate not permitted — pill fallback handles it */ }
  }
})()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(?:googleapis|gstatic)\.com$/.test(url.host);
  if (!sameOrigin && !isFont) return; // let APIs / other origins pass straight through

  const isAsset = isFont || /\.(?:svg|png|jpe?g|webp|ico|woff2?|ttf|mp3)$/.test(url.pathname);

  if (isAsset) {
    // cache-first
    e.respondWith((async () => {
      const key = keyFor(req);
      const hit = await caches.match(key);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(CACHE)).put(key, res.clone());
        return res;
      } catch { return hit || Response.error(); }
    })());
    return;
  }

  // network-first (navigations, app.js, styles.css, JSON)
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(CACHE)).put(keyFor(req), res.clone());
      return res;
    } catch {
      const hit = await caches.match(keyFor(req));
      if (hit) return hit;
      if (req.mode === "navigate") return (await caches.match(keyFor(new Request(url.origin + url.pathname.replace(/[^/]*$/, "") + "index.html")))) || Response.error();
      return Response.error();
    }
  })());
});
