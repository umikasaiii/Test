# Presence — LOCAL TESTED (workerd Durable Objects), BROWSER VERIFIED (Chromium)

One **Presence Durable Object per user** (`cloud/worker/src/presence.ts`) with **hibernatable WebSockets**.

| Status | Definition |
|---|---|
| `ONLINE` | at least one live socket on any device/tab |
| `IN_GAME` | a game session holds the user's *lease* (renewed every 30 s while the session lives, expires after 90 s on its own) |
| `OFFLINE` | no live socket and no lease |

* The PWA keeps `/api/ws` open, pings every 20 s, reconnects with backoff and refreshes on `visibilitychange`.
* **Closed browser:** socket close → recompute. **Silent network loss:** no pings for 65 s → the alarm (every 20 s while anything is live)
  closes the socket. **Several devices / refresh:** a new socket opens before the old closes; the status never flips while one is alive.
  **Never "online forever":** every state has a timeout (socket staleness, game lease).
* Status changes are pushed to the user's friends' DOs (`presence` events) and to the user's own other devices (`self_presence`).
* Only the Worker can reach the DO's WebSocket endpoint (it requires the `x-dslink-user` header set after authentication); direct
  access returns 403.

## Tests
`friends.test.ts › presence` (online/offline + friend notification, multi-device and refresh, ping/pong and the stale sweep,
IN_GAME lease expiry, authentication) and `pwa_e2e.mjs` (friend ONLINE, **browser closed → OFFLINE for the friend**, IN_GAME during a
session and ONLINE again after, INVITA disabled for an offline friend).
**Not tested:** mobile Safari background/suspend behaviour (a suspended tab drops its socket → shows OFFLINE after ≤65 s, by design),
very large friend lists (fan-out is one RPC per friend).
