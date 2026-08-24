// Hard Bop 24 service worker. Bump CACHE to force a clean re-precache.
const CACHE = "hardbop24-v1";

const SHELL = [
  "./",
  "player.css",
  "player.js",
  "manifest.webmanifest",
  "fonts/archivo-latin-var.woff2",
  "icons/hardbop24.svg",
  "icons/hardbop24.ico",
  "icons/hardbop24-180.png",
  "icons/hardbop24-192.png",
  "icons/hardbop24-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never touch another origin. Everything on radio.lysn.bar goes straight to the
  // network: the audio stream is endless so caching it is unbounded, and stale Now
  // Playing data is worse than none. Returning without respondWith leaves the request
  // entirely to the browser.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations are network-first so a deploy takes effect on the next load, with the
  // cached shell as the offline fallback. Cache-first here is the classic trap where
  // stale JS survives until someone remembers to bump the version.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("./", copy));
          }
          return res;
        })
        .catch(() => caches.match("./"))
    );
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
