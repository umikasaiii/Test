# Storage layout — D1 (metadata) and R2 (bytes)

**No blobs in the database. No public bucket.**

## R2 (private bucket `dslink-private`; bound as `STORE`; never public, no custom domain, no `r2.dev`)
```
u/<userId>/g/<gameId>/<fileId>       game files (ROM / CHD / CUE / BIN)  — opaque ids: names live only in D1
u/<userId>/sys/<platform>/<name>    BIOS / firmware
u/<userId>/saves/<gameId>/<kind>    sram | memcard1 | memcard2
```
All access is through the Worker (ownership checked by `userId` in the key and in D1), through a **presigned PUT** minted for the owner
(upload only), or through the container ticket route. Account deletion = delete the prefix `u/<userId>/`.

## D1 (`cloud/worker/migrations/0001_init.sql`)
`users` · `credentials` (passkeys) · `auth_sessions` (token hashes) · `challenges` · `login_attempts` · `friend_requests` · `friendships` ·
`games` · `game_files` (role, size, r2 key, ok) · `system_files` · `saves` (metadata) · `invites` · `play_sessions` (history).
Foreign keys cascade from `users`, so deleting a user row removes dependants; the play-session history of the *other* player keeps its
row with the deleted user anonymised.

## Durable Objects
* `Presence` — per user: sockets, game lease, last status. Storage is wiped on account deletion.
* `GameSession` — per session: room, membership, slots, gateway tokens, content tickets (SHA-256 only), lifecycle alarm, container control.

## Saves
The container flushes the host's SRAM on end (`POST /api/internal/end` → PUT `/internal/sessions/:id/save/sram` with the ticket) and restores
it at the next start. Users can also export/import a save (`GET|PUT|DELETE /api/library/games/:id/save/:kind`, ≤8 MiB).
**Verified:** the container flush+upload path (8 KiB SRAM from the core reaches the content server) and the user export/import round-trip.
**Not verified:** a save written *by a game* surviving a full restart (the homebrew ROM writes no save data).

## Cloudflare plan notes
Worker request bodies are limited (we cap proxied uploads at 95 MiB); large `.chd`/`.bin` need the presigned path
(`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` secrets). The presigning code is CODED but could not be
tested against a real R2 endpoint here.
