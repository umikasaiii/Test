// DSLink PWA service worker: caches the player shell and the emulator core so the player starts offline. Nothing private is ever fetched by this app, so there is nothing private to cache.
// All paths are relative to the worker's scope so the app works under any base path (a domain root, /play/, a GitHub Pages project path).
const CACHE = "dslink-play-v2";
const BASE = new URL("./", self.location).href, UP = new URL("../", self.location).href;
const SHELL = ["", "index.html", "play.js", "play.css", "player.js", "video.js", "storage.js", "sha256.js", "emulator.worker.js", "audio-worklet.js", "render-worker.js", "options.js", "core/dslink_wasm.js", "core/dslink_wasm.wasm", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"].map((p) => BASE + p).concat(["controls/controls.css", "controls/controls.js", "controls/layouts.js", "controls/components.js", "controls/input.js", "controls/menu.js", "mp/mp.css"].map((p) => UP + p));
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !SHELL.includes(u.href.split("?")[0])) return;     // only the shell: never an API, never anything private
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
