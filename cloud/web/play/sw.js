// DSLink PWA service worker: caches the player shell and the emulator core so the player starts offline. Nothing private is ever fetched by this app, so there is nothing private to cache.
// All paths are relative to the worker's scope so the app works under any base path (a domain root, /play/, a GitHub Pages project path).
const CACHE = "dslink-play-v5", FLAGS = "dslink-flags";
const BASE = new URL("./", self.location).href, UP = new URL("../", self.location).href;
const SHELL = ["", "index.html", "play.js", "play.css", "player.js", "video.js", "storage.js", "sha256.js", "emulator.worker.js", "audio-worklet.js", "render-worker.js", "options.js", "radio-ring.js", "radio-peer.js", "session.js", "friends.js", "dlassist.js", "cloud.js", "cloudui.js", "cloud-config.json", "core/dslink_wasm.js", "core/dslink_wasm.wasm", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"].map((p) => BASE + p).concat(["controls/controls.css", "controls/controls.js", "controls/layouts.js", "controls/components.js", "controls/input.js", "controls/menu.js", "mp/mp.css", "mp/vendor/qrcode.js"].map((p) => UP + p));
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== FLAGS).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// Cross-origin isolation for static hosting (SharedArrayBuffer for the DS radio receive ring in Distributed mode): when the page asked for it, this worker adds COOP/COEP to the
// same-origin responses it serves. Off by default; the choice is kept in a tiny cache entry. Nothing else about the app depends on it (the radio has a message-queue fallback).
let COI = null;
const coiOn = async () => (COI === null ? (COI = !!(await caches.match(BASE + "__coi", { cacheName: FLAGS }))) : COI);
self.addEventListener("message", (e) => {
  if (!e.data || e.data.t !== "coi") return;
  e.waitUntil((async () => { const c = await caches.open(FLAGS); if (e.data.on) await c.put(BASE + "__coi", new Response("1")); else await c.delete(BASE + "__coi"); COI = !!e.data.on; if (e.source) e.source.postMessage({ t: "coi", on: COI }); })());
});
const isolate = (r) => {
  if (!r || r.type === "opaque" || r.status === 0) return r;
  const h = new Headers(r.headers); h.set("Cross-Origin-Opener-Policy", "same-origin"); h.set("Cross-Origin-Embedder-Policy", "require-corp"); h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
};
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const clean = u.href.split("?")[0], shell = SHELL.includes(clean), inScope = (clean.startsWith(UP) || clean === BASE.slice(0, -1)) && !u.pathname.includes("/signal/");
  if (!shell && !inScope) return;
  e.respondWith((async () => {
    const coi = await coiOn(); if (!shell && !coi) return fetch(e.request);                    // only the shell is ever cached: never an API, never anything private
    let r;
    if (shell) r = await fetch(e.request).then((x) => { if (x.ok) { const copy = x.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return x; }).catch(() => caches.match(e.request, { ignoreSearch: true }));
    else r = await fetch(e.request);
    return coi ? isolate(r) : r;
  })());
});
