# Security and privacy

## Privacy rules (hard)
ROM, BIOS and firmware files are **never** public, in the repository, in any container image, available to other users, indexed, or in logs.
* Repository/image: only homebrew test ROMs built from this repo's own code (`tests/rom/`); CI builds them; the Dockerfiles copy no content.
* Other users: library/session routes return 404 (not 403) for objects you do not own; there is no endpoint that serves ROM/BIOS bytes to a browser.
* **Player 2 never receives Player 1's ROM.** The browser never gets content bytes at all. The container pulls the host's files with a
  **one-time-per-object ticket** (random 192-bit, stored hashed, 10-minute TTL, bound to the session) *and* the shared internal secret
  (`INTERNAL_TOKEN`, constant-time compare). Tickets resolve to exactly: the host's game files, each slot's **own** firmware, the host's save.
  Tests: a logged-in guest gets 401 on the internal routes; a wrong/expired/reused ticket gets 403; slot 2 fetches *its* firmware, not slot 1's.
* Logs: structured events carry no names, keys or paths (a test asserts that file names and `u/` keys never appear); the gateway logs
  "cannot fetch the game" without paths. Runtime logs contain core messages (paths inside the container's private work directory).
* Container lifecycle: work directories (`room/`, `fw/`, `slot*/`) are deleted on session end and the container is destroyed; tickets are deleted.

## Authentication and sessions
See [AUTH.md](AUTH.md): passkeys via a maintained library; PBKDF2-SHA256 600k; token hashes only; HttpOnly+Secure+SameSite=Lax cookies; CSRF origin
check; login throttling; challenge single-use.

## Transport and abuse
* The internal gateway endpoints (`/api/internal/*`) do not exist unless `DSLINK_INTERNAL_TOKEN` is set, and need it.
* Uploads: size limits per role, header validation at add time and re-validation from R2 at completion, safe object keys (ids, never names).
* The PWA inserts user text only with `textContent`. No third-party scripts. The service worker caches only the app shell, never `/api/*`.
* WebRTC: the browser only receives its own slot's tracks and can only send button/touch events; DS packets never leave the container.

## Known gaps (not mitigated yet)
* No rate limiting beyond password login (Cloudflare WAF/rate-limit rules should be added at deployment).
* No content-security-policy header yet (the PWA is CSP-friendly: one module script, no inline script).
* `INTERNAL_TOKEN` is a single shared secret; per-container credentials would be stronger.
* Presigned URLs are bearer URLs for 15 minutes.
* Not penetration-tested; no external review. Container isolation is Cloudflare's.
* Legal: DSLink is a frontend. Users are responsible for owning the games and firmware they upload. GPLv3 for the code.
