// Service worker minimal — cukup buat memenuhi syarat "installable PWA".
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => self.clients.claim());
self.addEventListener("fetch", e => {
  // passthrough biasa (selalu ambil dari jaringan)
});
