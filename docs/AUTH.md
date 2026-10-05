# Accounts (`cloud/worker/src/auth.ts`) — LOCAL TESTED (workerd + D1), BROWSER VERIFIED (Chromium virtual authenticator), NOT DEPLOYED

An account has `userId`, `username` (unique, case-insensitive, `a-z0-9_`, 3–20), `displayName`, `avatar` (preset id), `createdAt`.

## Sign-in methods
1. **Passkeys / WebAuthn (preferred).** `@simplewebauthn/server` verifies registration and assertions; discoverable credentials, so
   login needs no username. `attestation: none`, user verification *preferred*, challenges are single-use rows in D1 with a 5-minute
   TTL, origin and RP ID are pinned from configuration, the signature counter is stored. Additional passkeys can be added while logged in.
2. **Username + password** (fallback). Hashed with **PBKDF2-SHA256, 600 000 iterations, 16-byte random salt per user** via WebCrypto
   (no home-grown crypto); constant-time comparison; the KDF always runs, so unknown users and passkey-only accounts are
   indistinguishable by timing or message; **5 failures / 15 min per username → 429**.

E-mail is not collected. Recovery for passkey-only users is "add a second passkey on another device"; there is deliberately no e-mail reset.

## Sessions
Random 256-bit token; only its SHA-256 is stored (`auth_sessions`). Delivered as `HttpOnly; Secure; SameSite=Lax` cookie (and as a
bearer token for non-browser clients). 30-day expiry; logout deletes the row; `POST /api/logout-all` kills every session.
State-changing requests with an `Origin` header must match a configured origin (CSRF).

## Endpoints
`POST /api/auth/register|login|logout` · `POST /api/auth/passkey/{register,login,add}/{options,verify}` · `GET|PATCH /api/me` ·
`DELETE /api/account` (body must repeat the username; ends live sessions, purges D1 rows and R2 objects — see [STORAGE.md](STORAGE.md)).

## Tests
`cloud/worker/test/auth.test.ts` (13): registration/login/logout, no clear-text secrets stored, per-user salts, validation, throttling,
passkey register + discoverable login with a software authenticator, challenge single-use and replay rejection, wrong-origin assertion
rejected, second passkey, CSRF origin check. `cloud/tests/pwa_e2e.mjs`: passkey registration, logout and discoverable login in Chromium
with a CDP virtual authenticator, password registration.
**Not tested:** Safari/iOS and Android passkey UX, cross-device (hybrid) passkeys, real deployment RP ID/origin configuration.
