
const CACHE_NAME = "lumos-ia-v1";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/lumos-icon.png",
  "/favicon.ico"
];

// Installazione e cache iniziale
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// Attivazione e pulizia delle vecchie cache
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Gestione delle richieste
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Non intercettare richieste non GET o servizi esterni/API
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/auth/")
  ) {
    return;
  }

  // Pagine: prova prima la rete, poi usa la cache
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) =>
              cache.put("/index.html", copy)
            );
          }
          return response;
        })
        .catch(async () => {
          return (
            await caches.match("/index.html")
          ) || Response.error();
        })
    );
    return;
  }

  // File statici: prima la cache, poi la rete
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) =>
            cache.put(request, copy)
          );
        }
        return response;
      });
    })
  );
});
