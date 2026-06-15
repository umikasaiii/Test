'use strict';

const CACHE = 'progressione-v1';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.svg', './icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && e.request.url.startsWith(self.location.origin)) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});

// ── Peso notification scheduler ──────────────────────────────
let _notifTimer = null;

function scheduleNextNotif(schedule) {
  if (_notifTimer) { clearTimeout(_notifTimer); _notifTimer = null; }
  const next = new Date(schedule.nextCheck);
  const delay = next.getTime() - Date.now();
  if (delay < 0 || delay > 8 * 24 * 60 * 60 * 1000) return;
  _notifTimer = setTimeout(async () => {
    await self.registration.showNotification('Progressione — Peso corporeo', {
      body: 'È il giorno del peso! Registra la tua misura settimanale.',
      icon: './icon-192.svg',
      badge: './icon-192.svg',
      tag: 'peso-settimanale',
      renotify: false,
      data: { url: './' }
    });
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'PESO_NOTIF_FIRED' }));
  }, Math.max(1000, delay));
}

self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_WEIGHT') scheduleNextNotif(e.data.schedule);
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const focused = clients.find(c => c.visibilityState === 'visible');
      return focused ? focused.focus() : self.clients.openWindow('./');
    })
  );
});
