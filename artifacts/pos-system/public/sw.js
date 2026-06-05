// 🔴 2026-05-25 (Khushi PWA request) — minimal service worker so Android
// Chrome shows the "Add to Home Screen" install prompt. We DELIBERATELY
// do NOT cache app shell or API responses here, because:
//   1. The POS is online-only (Firestore live listeners drive everything).
//   2. A stale cached build would silently serve old menu/PIN logic and
//      cause a fraud-control nightmare ("why is Bar Mode still letting
//      this PIN through?!").
// 🛟 FALLBACK: if Chrome later refuses install without offline support,
// add a cache.addAll(['./']) on install, OR install vite-plugin-pwa for
// a proper Workbox-managed SW. For now, pass-through fetch + skipWaiting
// is enough to satisfy the PWA install criteria.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through — let the network handle it (fail-open, no stale data).
});
