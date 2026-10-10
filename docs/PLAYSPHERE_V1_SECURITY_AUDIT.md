# PlaySphere V1 — security and privacy audit (FASE 9)

Scope: the PWA (`cloud/web/play`), the Cloud Worker (`cloud/worker/src`), the gateway for the legacy hosted mode, and what the app stores. Method: code reading of every route and every place user data is written to the DOM, the existing vitest suites (`cloud/worker/test`, 100 tests before this phase, 103 after), the browser end-to-end suites, and new tests added in this phase. This is a self-audit, not an independent penetration test.

## Result in one line

No critical or high finding open. **Three findings fixed in this phase** (abuse limits on invites, friend requests and user search; no Content-Security-Policy; diagnostic hooks always exposed), one medium residual risk (rate limits are per Worker isolate), a few low items listed in `PLAYSPHERE_V1_KNOWN_ISSUES.md`.

## Findings fixed in FASE 9

| # | Finding | Severity | Fix | Evidence |
|---|---|---|---|---|
| S1 | **Invite abuse**: `POST /api/play/invites` had no per-account limit; each call opens a room (Durable Object) and rings a friend's phone, so a hostile friend could spam invites and rooms | medium | 20 invites / 10 min / account | `cloud/worker/test/abuse.test.ts` |
| S2 | **Friend-request spam and user enumeration**: no limit on `POST /api/friends/requests` or `GET /api/users/search` | medium | 30 requests / 10 min and 90 searches / 10 min / account | `abuse.test.ts` |
| S3 | **No Content-Security-Policy**: an injected script would have run with the app's privileges | medium | Production CSP (`cloud/csp.txt`, applied through `_headers`): scripts only from this origin + `wasm-unsafe-eval`, no inline script, no `eval`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; plus `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera and microphone only for this origin). The theme bootstrap moved from an inline script to `theme-init.js` | `play_csp_worker.mjs` (9 checks on the real Worker: headers, service worker, both cores, workers, themes, no violation, not frameable); `play_ui_e2e.mjs` (production CSP on the static host) |
| S4 | The diagnostic surface `window.dslinkPlay` (store, player, internals) was always present | low | Exists only in development, in automated browsers (`navigator.webdriver`) or with `?hooks=1` | `play.js` (`HOOKS()`) |

## Area by area

| Area | Verdict | What was checked |
|---|---|---|
| **Authentication** | OK | Passkeys (WebAuthn) + password (PBKDF2-SHA256, 600 000 iterations, per-user salt, NFKC); wrong password and unknown user answer identically; repeated failures lock (`auth.test.ts`). Sessions are server side, 30 days, listable and revocable per device (`cloudbase.test.ts`). |
| **CSRF** | OK | State-changing requests with an `Origin` outside the allow-list get 403; the session cookie is `HttpOnly`, `SameSite=Lax` for the own origin (`SameSite=None; Secure` only for an allow-listed other origin) (`auth.test.ts`, `cloudbase.test.ts`). |
| **CORS** | OK | Only exact origins from `ORIGINS` are echoed, with credentials, never `*`; preflight answered for those only (`cloudbase.test.ts`). WebSocket opens with a one-shot ticket (30 s, not reusable, origin-checked) against cross-site hijacking. |
| **XSS** | OK | Every `innerHTML` in the app is the empty string (verified by grep; user text always goes through `textContent` / `createTextNode` via `h()`); no `eval`, `new Function`, `document.write`, `insertAdjacentHTML` (checked by `play_ui_e2e.mjs` on every run); CSP above as the second line. Inline `style` attributes remain allowed (`style-src 'unsafe-inline'`): residual, low. |
| **IDOR** | OK | Every query is parameterised and scoped by the session's `user_id`; another account cannot list, read, delete, resume, finish or overwrite files, games or saves (`cloudfiles.test.ts` "CROSS-ACCOUNT", `library.test.ts`); a user who is not the recipient of an invite gets the same 404 as for a missing one. |
| **File upload** | OK | Files are checked for what they claim to be (DS header, BIOS sizes, PlayStation BIOS names), size-capped per kind and per account quota, uploaded in verified parts (SHA-256), at most 8 pending uploads per account, rate limited (`library.test.ts`, `cloudfiles.test.ts`). PlayStation disc images are never uploaded. |
| **R2 authorization** | OK | The bucket (`dslink-private`) has no public access and no custom domain; objects are only reachable through authenticated Worker routes; the object key is only ever obtained from the caller's own database row (`WHERE user_id = ? AND kind = ? AND name = ?`), so one account cannot address another account's object; deletes are owner-only. |
| **Room authorization** | OK | Rooms are 6-digit codes with per-IP join lockout, one host token and one guest token, whitelisted signalling messages, no payload stored, closed on refuse / cancel / expiry / block (`signal_contract.mjs`, `cloudbase.test.ts`). |
| **Party authorization** | OK | Only the owner can kick; a party of others / a full party / an expired invite is refused; create / invite / join are rate limited; blocking removes the person from invites and the party (`internet.test.ts`). |
| **TURN credentials** | OK | Short-lived (per-request) credentials derived from the shared secret (`use-auth-secret` scheme); the secret never leaves the Worker; a different account gets a different credential; `/api/realtime/ice` requires a session and is rate limited; no permanent credential appears in any served file (`internet.test.ts`, `play_internet_e2e.mjs`). |
| **Session expiry** | OK | Expired and revoked sessions, disabled accounts, one-shot tickets and expired invites are refused (`cloudbase.test.ts`). |
| **Rate limiting** | OK with a limit | Login, uploads, saves, ICE, party actions and (new) invites, friend requests and searches are throttled per account. The counters live in each Worker isolate's memory: they stop a script or a runaway client, **not a distributed attack**. Production should also use Cloudflare rate-limiting rules on `/api/auth/*` and `/api/users/search`. |
| **Invite abuse** | OK | One open invite per pair (a new one replaces the old one and closes its room), only to friends, only if the friend is online and not in a game, blocked users cannot invite, plus S1. |
| **Third-party content** | OK | No external scripts, fonts, analytics or CDNs: the CSP makes that enforceable. |

## Privacy audit

| Question | Answer | How it is guaranteed |
|---|---|---|
| Are ROMs, BIOS and firmware private? | Yes | They live in the browser storage of the device; only if the user turns on Cloud do DS games and system files go to **their own** private R2 space (owner-only routes). Neither is in the repository, the APK, the PWA package or any CI artifact (`scripts/check_no_private.py`, the package guard in `wasm.yml`). |
| Are saves private? | Yes | Local by default; Cloud saves are per account, revisioned, owner-only. PlayStation memory cards sync as saves; disc images never leave the device. |
| Is Party Voice recorded? | No | Audio is a peer-to-peer WebRTC mesh between the participants; the server only exchanges signalling. No `MediaRecorder`, no audio capture API and no audio route exist in the code (grep over `cloud/`), and nothing in the Worker stores audio. |
| Can storage become public by accident? | No | The R2 bucket binding is private; there is no public bucket URL, no listing route, and the Worker never serves an object without an authenticated owner check. |
| What is sent to the server without Cloud? | Nothing about the library | Anonymous play makes no account request; room signalling carries a code and tokens, never a file name. With an account, the library **metadata** (title, platform, product code) is synced, never a path, size or content (asserted by `play_cloud_e2e.mjs`). |
| Logs | Minimal | The app writes no console logs. The Worker logs structured events with a platform tag only (no title, no user text, no token, no TURN secret). Private file names never appear in logs. |

## Residual risks (all listed in the known-issues file)

1. Per-isolate rate limits (above). 2. `style-src 'unsafe-inline'` (inline `style` attributes are used by the UI). 3. Destructive actions still use the browser's native `confirm()` dialog. 4. The audit was done by the author of the code: an independent review is recommended before a public launch.
