# Cloudflare — real deployment

**Status: NOT DEPLOYED.** The sandbox this project is built in cannot reach `api.cloudflare.com` / `*.workers.dev` and has no Cloudflare
credentials, and has no Docker daemon (Containers images are built by `wrangler deploy` with Docker). Everything below is CODED and the pieces
that can be proven locally are proven (see "What is verified"). Nothing here claims a deployed or public result.

## One-time setup (3 things only the account owner can do)

1. Create a Cloudflare API token (My Profile → API Tokens → Create Custom Token) with, for the account:
   `Workers Scripts: Edit`, `D1: Edit`, `Workers R2 Storage: Edit`, `Containers (Cloudchamber): Edit`, `Account Settings: Read`,
   `Realtime/Calls: Edit` (the TURN key). The account must be on **Workers Paid** (Containers + Durable Objects SQLite).
2. In the GitHub repository settings → Secrets and variables → Actions add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   Optional (presigned direct-to-R2 uploads for files > 95 MiB): an R2 API token (Object Read & Write on `dslink-private`) as
   `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`.
3. Run the workflow **deploy-cloudflare** (Actions → Run workflow). It: type-checks + unit-tests the Worker, provisions D1 `dslink` and the
   private R2 bucket `dslink-private` when the account has R2 (OPTIONAL: without R2 the deploy carries on in local storage mode, see CLOUD_STORAGE.md) (`scripts/cf_prepare.py`, idempotent), applies D1 migrations, deploys Worker + PWA assets +
   Durable Objects + the Container image (`cloud/Dockerfile.runtime`: DSLink Runtime + melonDS DS + gateway — **no RetroArch, no ROM/BIOS/firmware**),
   creates the Realtime TURN key and the internal secret if missing, smoke-tests the public URL, then runs the **public end-to-end**
   (`pwa_e2e.mjs`: two accounts, friends, presence, invite, cloud session in a real Container, WebRTC) and `r2_real.mjs` (real R2).

For my own live tests from the agent sandbox the environment additionally needs the network hosts `api.cloudflare.com`, `developers.cloudflare.com`
and `*.workers.dev` allowed (Environment → Network access), and the same two values as environment variables.

## The media path (important, verified against the Containers docs)

Cloudflare Containers accept **no inbound TCP/UDP from end users**: every request reaches the container through a Worker/Durable Object
(`getTcpPort`/`fetch`). A WebRTC peer that waits for UDP on `:50000-50100` (the original gateway design) cannot work there. DSLink therefore uses
**Cloudflare Realtime TURN** as the rendezvous:

```
browser ──ICE──▶ turn.cloudflare.com ◀──ICE (TURN client, outbound)── gateway in the Container
              (relay candidate)                 (relay candidate)
signalling:  browser ─WS─▶ Worker ─▶ GameSession DO ─▶ container.fetch  (WebSocket upgrade)
```

* The Worker mints short-lived credentials (`POST rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers`, TTL ≤ 48 h)
  with the TURN key secret that never leaves the Worker: browsers get them from `/api/config`, the container gets its own set in the
  `internal/session` payload (`ice`, `iceRelayOnly:true`) → the gateway uses `ICETransportPolicy=relay`.
* `ICE_POLICY=relay` (Worker var) forces browsers through TURN as well (restrictive networks / tests).
* Realtime SFU is **not** needed: two independent per-slot streams are produced by the container; TURN relays them. SFU stays the choice for
  Party Voice (many-to-many) later.

## What is verified (locally, real code paths)

| Check | Result |
|---|---|
| Worker: tsc + vitest (incl. TURN minting unit tests) | 51/51 (was 48) |
| Two browsers, Player 1/2 isolated streams/input/touch, **relay-only through a local TURN server** (`cloud/tests/turn_relay.sh`) | 19/19, selected pair `relay<->relay`, ~57–60 fps |
| PWA end-to-end (Worker + gateway, accounts/friends/invite/session) | 35/35 |
| Library flow incl. cross-account isolation, header validation, saves, delete (`r2_real.mjs`, against Miniflare R2) | 18/18 |

## What is NOT verified (needs the real account)

* Real deploy, public URL, real D1/R2, presigned PUT against `*.r2.cloudflarestorage.com`.
* Container cold start, whether outbound UDP/TCP from the Container to `turn.cloudflare.com` works as expected (the TURN list Cloudflare returns includes
  UDP 3478, TCP and TLS 443 variants; pion/ice handles all of them), CPU/RAM/fps on the real instance, real internet latency, packet loss, NAT.
* `POST /accounts/{id}/calls/turn_keys` (used by the workflow to create the TURN key) — taken from the Realtime docs; if the API differs the workflow fails
  loudly at that step and the key can be created in the dashboard (Realtime → TURN) and stored as `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` Worker secrets.
* Android Chrome ↔ iPhone Safari: **DEVICE PENDING**.

## Internet multiplayer and Party Voice (FASE 7)

Optional TURN for players on different networks: repository variables `TURN_PROVIDER`, `TURN_URL`, `DSLINK_STUN_URLS` and the secret `TURN_SECRET` (coturn `static-auth-secret`); the Worker derives short-lived credentials (`GET /api/realtime/ice`). Without TURN the app uses STUN and says the relay is unavailable. D1 migration `0004_party_net.sql` and the `PartyRoom` Durable Object are applied by the same workflow. See [INTERNET_VOICE.md](INTERNET_VOICE.md).
