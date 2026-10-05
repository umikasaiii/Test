# Private game library — LOCAL TESTED (workerd + R2/D1), BROWSER VERIFIED (Chromium, upload through the UI)

Every account has its own library. **DSLink ships, downloads, searches and recommends nothing**: the user adds files from their own device.

## Adding a game ("+ AGGIUNGI GIOCO")
1. The PWA reads the first 1 KiB of each chosen file and sends `{name, size, header}` to `POST /api/library/games`.
2. The Worker **detects the platform from the header structure** and rejects anything else (415):
   * `.nds` → valid NDS header: logo-CRC field `0xCF56` at `0x15C` and header CRC-16 over `0x000–0x15D` matching `0x15E`; title from the header.
   * `.chd` → `MComprHD` magic → PlayStation.
   * `.cue` + `.bin` → one cue and ≥1 bin; the cue (≤64 KiB text with `FILE`/`TRACK`) must reference **exactly** the uploaded bins.
   * a lone `.bin`, mixed sets, duplicates, other extensions → rejected. Size limits per role (rom 512 MiB, chd 2 GiB, bin 1 GiB, cue 64 KiB).
3. The response lists one upload per file. With R2 S3 credentials configured the URL is a **presigned direct-to-R2 PUT** (15 min, size
   bound); without them it is a Worker-proxied PUT (≤95 MiB) — same ownership checks, used by tests and small files.
4. `POST /api/library/games/:id/complete` re-validates server-side from what is **actually in R2** (size equals declaration, NDS header
   re-read, CHD magic, cue ↔ bin match). A client that lies in the header is caught here and everything it uploaded is deleted.
   Pending games older than 24 h are garbage-collected.

## Playing and inviting
**GIOCA** starts a solo session (Player 1 only); **INVITA** invites an ONLINE friend ([FRIENDS.md](FRIENDS.md)). Per game the library keeps
title (renamable), platform, size, file list and whether a save exists.

## Platforms
* **Nintendo DS** (CODED + LOCAL TESTED end to end with homebrew): Account A = DS #1 with the ROM; Account B = DS #2 **without cartridge**
  (for DS Download Play). DS ↔ DS wireless traffic stays inside the container over the bridge. **Player 2 never receives Player 1's ROM**
  (see [SECURITY.md](SECURITY.md)). Each console uses the *owner's own* BIOS/firmware.
* **PlayStation 1** (CODED at the library level only): `.chd` / `.cue+.bin` are accepted, stored and validated, with BIOS import and
  `memcard1/2` save slots. **No PS1 core is integrated in the Runtime or the gateway yet** (the gateway answers 501 for non-DS
  sessions) and the two-ports-one-console mapping (Player 1 → port 0, Player 2 → port 1 of a single Runtime) is designed
  (LIBRETRO_HOST.md: 4 ports exist in the host) but **not implemented or tested**.

## BIOS / firmware
`PUT /api/library/system/nds/{bios7,bios9,firmware}.bin` (exact sizes enforced) and `…/ps1/<name>.bin` (512 KiB). Listing returns metadata only —
there is **no endpoint that returns the bytes to any browser**. They reach a container only through the ticketed internal route, only for
the slot of their owner.

## Deletion
Delete one game (removes R2 objects + rows + saves), "Elimina tutta la libreria", delete a BIOS file, or **delete the account** —
`DELETE /api/account` (confirmation = username) ends live sessions, deletes every R2 object under `u/<userId>/` and every row; verified by
tests that list R2 and D1 afterwards.

## Tests
`library.test.ts` (12): add/detect, rejection of fake/unknown files, lying-header catch, size mismatch, CHD and CUE+BIN (incl. mismatch),
rename/delete with R2 cleanup, cross-user isolation, no route serving bytes, BIOS validation, saves round-trip, no names/keys in logs,
account deletion. `pwa_e2e.mjs`: upload through the UI, junk refused, B cannot see A's library.
