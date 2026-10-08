# DSLink Cloud storage (FASE 6/9): private library, system files, cloud saves, definitive hosting

Netlify is **not** part of the architecture any more. One Cloudflare Worker serves everything on one origin:

```
https://<dslink-worker>/
├── play/      PWA (JS, CSS, melonDS WebAssembly core, manifest, service worker)   <- Workers static assets
├── api/       account, library, files, saves, friends, invites, presence           <- Worker
└── signal     WebRTC signaling (one Durable Object per room)                        <- Worker
Bindings: D1 (metadata) · Durable Objects (rooms, presence) · R2 PRIVATE (the users' own files)
```
Emulation never leaves the device. R2 only holds copies of files the user chose to store, and nothing is ever executed from R2: a ROM is downloaded, hash-verified, written to OPFS/IndexedDB, and only then started.

## R2 layout (opaque keys; D1 keeps the names, sizes and SHA-256)
```
u/<user-id>/cf/game/<random>      ROM        (D1 cloud_files: kind=game,   name=nds-<product code>)
u/<user-id>/cf/system/<random>   BIOS/firmware (kind=system, name=bios7.bin | bios9.bin | firmware.bin)
u/<user-id>/cs/<game-id>/<rev>-<random>   save revisions (D1 cloud_saves, last 5 kept)
```
A file name or game id is never part of a path, so there is nothing to traverse; every lookup is `(user_id from the session, kind, name)`.

## Privacy rules (enforced in `cloud/worker/src/files.ts`, tested in `test/cloudfiles.test.ts`)
* The bucket has no `r2.dev` URL and no custom domain (`scripts/cf_prepare.py` checks and refuses to continue if either is on). Access = authenticated Worker streaming only. No permanent or presigned URLs.
* Another account gets `404` for every id, upload id and save revision of yours (indistinguishable from "missing"). Anonymous callers get `401`.
* Ownership comes from the session, never from a client-supplied user id. Names are validated against `^[a-z0-9]{2,8}-[a-z0-9]{4,12}$` or the three system file names.
* Uploads are validated on the server **by structure**, not by extension or Content-Type: a ROM must have a valid Nintendo DS header (logo CRC + header CRC) and its game id must equal its own product code; system files must have the exact BIOS/firmware sizes. Downloads are always `application/octet-stream`, `nosniff`, `attachment`, `no-store`.
* The Worker streams the stored object through SHA-256 on completion and compares it with the hash the client declared (integrity + per-account deduplication). A mismatch deletes the object.
* Limits: ROM 512 MiB, save 8 MiB, parts 8 MiB, per-account quota (`QUOTA_MB`, default 2048), 8 uploads in flight, rate limits on upload starts and save writes. Quota errors are `507 cloud_quota_exceeded`, R2 problems `503 storage_unavailable`; neither ever touches a local file.
* No file name, key, hash or content is logged (`logEvent` carries counters only).

## API (all under `/api`, cookie session or bearer, same-origin)
| | |
|---|---|
| `GET /storage` | used / quota bytes and counts |
| `GET /files` | `{games:[{gameId,title,size,sha256}], system:[{name,size,sha256}], quota, used}` |
| `POST /files/uploads` | start (`kind,name,size,sha256,header`) -> `{uploadId, mode: single|multipart, chunkSize, partsTotal}` or `{done:true}` when the same bytes are already stored |
| `PUT /files/uploads/:id/parts/:n` | one part (multipart = R2 multipart upload; never the whole file in memory) |
| `GET /files/uploads/:id` · `DELETE` | resume (which parts exist) · abort |
| `POST /files/uploads/:id/complete` | assemble, size + SHA-256 + header check, atomic replace |
| `GET /files/game/:id` · `/files/system/:name` | stream, `Range` supported (resumable download) |
| `DELETE /files/game/:id` · `/files/system/:name` | remove from the Cloud |
| `DELETE /files` `{confirm:<username>}` | delete **all** the account's Cloud files, uploads and saves (account stays) |
| `GET /saves` · `GET /saves/:game` · `GET /saves/:game/data[?rev=n]` | heads · history · bytes |
| `PUT /saves/:game?base=<rev>&sha=&device=&name=[&force=1]` | write the next revision |
| `POST /saves/:game/restore` `{revision,device}` | restore an old revision as a NEW revision |
| `DELETE /saves/:game` | delete the save history |
| `DELETE /account` `{confirm}` | already existing: wipes D1 rows and the whole `u/<user>/` R2 prefix |

## Local ↔ Cloud (PWA, `cloudfiles.js`, `play.js`)
States per game: **SOLO LOCALE** · **SOLO CLOUD** (shown on a new device right after login, with SCARICA / GIOCA) · **LOCALE + CLOUD**.
* Add a game: SOLO LOCALE by default; the option "Salva nel mio Cloud…" (or the per-game button SALVA NEL MIO CLOUD) uploads it with percentage / completed / error. Big files go up in 8 MiB parts from views of the in-memory file (no second copy); a failed part is retried; an aborted upload is removed on the server.
* GIOCA on a CLOUD ONLY game: download with progress into one pre-sized buffer (resumes with `Range` if the connection drops), SHA-256 check, write to OPFS/IndexedDB, then the normal local start. On a corrupted download nothing is stored. If the browser storage is full the partial copy is removed and the Cloud copy is untouched.
* RIMUOVI DAL DISPOSITIVO deletes only the local copy. RIMUOVI DAL CLOUD (with confirmation) deletes only the Cloud file (saves stay until you delete them from SALVATAGGI).
* BIOS/firmware: per-file SALVA NEL MIO CLOUD (or the same option at import). After login a device that lacks them gets them back automatically; a local file always wins. "Solo locale" stays the default.
* Download Play is unchanged: the guest of a single-card game uses firmware + Download Play, it never downloads the ROM because of an invite.
* The interface shows "Spazio locale utilizzato" and "Spazio Cloud utilizzato di …".

## Cloud save
The emulator keeps using the local save. The PWA copies it to the Cloud: on leaving a game, every 2 minutes while playing if it changed, when the network comes back, at start/login, before GIOCA (3.5 s at most: offline or slow never blocks the game) and on demand (SINCRONIZZA ORA). Only games that are in the account's Cloud (ROM stored, or a save already synced) are synchronised automatically; a local-only game's save stays local unless you press SINCRONIZZA ORA for it.

Each revision stores `game_id, user_id, device_id, device_name, updated_at, sha256, size, revision`; the last 5 are kept. Decision per game (local hash `L`, Cloud head `H`, last synced `S`):
* `L == H` → in sync. No Cloud save → upload. No local save → download.
* only the Cloud changed since `S` → download (the replaced local save is kept as `save.bak`). Only local changed → upload with `base = H.revision`.
* both changed (or never synced and different) → **conflict**: "Ci sono due salvataggi diversi" shows both devices with date/time; nothing is overwritten until the user taps USA QUESTO (this device's save becomes the newest revision, the other stays in the history) or USA L'ALTRO (the Cloud save replaces the local one, which is kept as `save.bak`). DECIDI DOPO keeps both.
* The server also enforces it: a write whose `base` is not the head gets `409 save_conflict` with the head's device and time; two simultaneous writers cannot both win.
* SALVATAGGI lists the revisions; RIPRISTINA creates a new revision from an old one.

## PWA updates (service worker)
`scripts/package_pwa.sh` stamps `const BUILD` in `sw.js` with a hash of every shell file (JS, CSS, WebAssembly core, controls) and writes `play/build.json`. A packaged build:
* installs by fetching the **whole** shell fresh and fails (the running version stays) if any file is missing; no half-filled cache is kept;
* serves its shell only from its own cache (`dslink-play-<build>`), so a new JS can never meet an old WASM core, online or offline;
* when a new version is found it **waits**: a running game is never reloaded or swapped. The menu shows "Nuova versione… AGGIORNA"; it also takes over on the next open. Old caches are deleted on activation.
The Worker serves `/play/sw.js` with `no-cache` and the rest with ETags, so a deploy replaces the PWA atomically at the same URL. `/api/*` and `/signal/*` are never intercepted or cached.

## Deploy (needs your Cloudflare credentials; nothing is created from the development sandbox)
1. Dashboard → R2 → enable R2 for the account (one time, needs a payment method on file; the free tier is enough to start).
2. My Profile → API Tokens → Create custom token: **Account · Workers Scripts: Edit**, **D1: Edit**, **Workers R2 Storage: Edit**, **Account Settings: Read**.
3. GitHub → Settings → Secrets and variables → Actions → secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. Make sure the account has a workers.dev subdomain (Workers & Pages → Overview).
5. Actions → **deploy-cloudflare** → Run workflow. It runs the private-file guard, tsc + vitest, builds WASM + the PWA, creates D1 `dslink` and the **private** R2 bucket `dslink-private` (refuses to continue if the bucket is public), applies the migrations (`0001`..`0003`), deploys Worker + assets at `https://dslink-cloud.<subdomain>.workers.dev`, sets `INTERNAL_TOKEN`, runs a smoke test (including a throw-away account that stores a save in R2, reads it back and is deleted), then the public browser tests.
6. Every later run replaces the PWA and the Worker at the **same URL**. D1, R2 and Durable Object data are never deleted by a deploy.
7. Custom domain later: Workers → dslink-cloud → Settings → Domains & Routes → add the domain, then set `ORIGINS` / `RP_ID` in `cloud/worker/wrangler.jsonc` to it (passkeys are bound to the domain; accounts created on workers.dev would need passkeys registered again, password accounts are unaffected).

## Tests
`cd cloud/worker && npx vitest run` (includes `cloudfiles.test.ts`: upload/download/multipart/resume/dedup/validation/cross-account/quota/rate limit/R2 down/purge/save revisions/conflicts/restore). Browser: `cloud/tests/play_cloud_files_e2e.mjs` (two phones, one account, real Worker + local R2), `play_sw_update.mjs` (update safety), plus the earlier `play_cloud_e2e.mjs` / `play_cloud_static.mjs`.

## Not in this phase
Cloud saves for PS1 / other cores, TURN, party voice, SFU, final redesign. BIOS/firmware/ROM of the user are never shipped by DSLink: they only travel between the user's devices and the user's own private space.
