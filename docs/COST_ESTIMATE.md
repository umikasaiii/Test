# Cost estimate (hourly, per game session)

Prices were looked up on 2026-10-05 from the Cloudflare docs via web search (Containers pricing, Realtime pricing, R2/D1/Durable Objects/Workers
pricing pages). They were **not** fetched from the pages directly (the sandbox has no access to developers.cloudflare.com): re-check the linked pages
before committing to a budget. Measurements are from the real DSLink Runtime + melonDS on this machine with the homebrew test ROMs, **not** from a
Cloudflare Container and **not** with Mario Party DS.

## Prices used (Workers Paid, $5/month base)

| Item | Price | Included |
|---|---|---|
| Containers vCPU | $0.000020 / vCPU-s | 375 vCPU-min / month |
| Containers memory | $0.0000025 / GiB-s | 25 GiB-h / month |
| Containers disk | $0.00000007 / GB-s | 200 GB-h / month |
| Containers egress (NA/EU) | $0.025 / GB | 1 TB / month |
| Realtime TURN/SFU egress | $0.05 / GB | 1,000 GB / month (shared) |
| R2 standard | $0.015 / GB-month; Class A $4.50/M; Class B $0.36/M; egress free | 10 GB, 1M A, 10M B |
| D1 | $0.75 / GB-month; $0.001 / M rows read; $1.00 / M rows written | 5 GB, 5M reads/day, 100k writes/day (free plan) |
| Durable Objects | $0.15 / M requests; $12.50 / M GB-s | — |

Instance types (docs): `standard-3` = 2 vCPU / 8 GiB / 16 GB; `standard-4` = 4 vCPU / 12 GiB / 20 GB; custom sizes are available since Jan 2026.

Sources: [Containers pricing](https://developers.cloudflare.com/containers/pricing/) · [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/) ·
[Realtime SFU/TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/) ·
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## Measured locally (2 DS instances, 1 room, VP8, test ROMs)

| Metric | Value |
|---|---|
| Session create → first frame (both browsers, local) | ≈ 2.2–2.9 s |
| Video per player | 59.7 fps, 512×768, ≈ 106–108 kbps (static test ROM — real games will be higher) |
| Audio per player | ≈ 119 kbps |
| Runtime CPU (per DS instance, average) | ≈ 27 % of one core → ≈ 0.55 core for the room |
| Runtime RSS | ≤ 170 MB per instance; gateway ≈ 24 MB |
| RTT local / through a local TURN relay | 1–3 ms (not representative of the internet) |

## Estimate per session-hour (2 players, 1 container)

Assumption for real games (to be measured): 2 Mbps video + 0.12 Mbps audio per player → ≈ 4.3 Mbps → ≈ 1.9 GB/h.

| Component | Provisioned-billing worst case, `standard-3` | Lean custom 1 vCPU / 2 GiB |
|---|---|---|
| vCPU | 2 × 3600 × $0.000020 = $0.144 | $0.072 |
| Memory | 8 × 3600 × $0.0000025 = $0.072 | $0.018 |
| Disk | 16 × 3600 × $0.00000007 = $0.004 | $0.001 |
| Egress container→TURN ($0.025/GB beyond the free TB) | ≈ $0.05 | ≈ $0.05 |
| TURN egress ($0.05/GB beyond the free 1,000 GB) | ≈ $0.10 | ≈ $0.10 |
| **Total / session-hour** | **≈ $0.37** | **≈ $0.24** |

If CPU is billed on active usage only (the pricing change announced for Containers), the lean case drops to ≈ $0.04/h of CPU instead of $0.072.
The monthly free allowances (375 vCPU-min, 25 GiB-h, 1 TB, 1,000 GB) cover the first ~hours of testing; at personal scale (a few hours/week) the
total is dominated by the $5/month Workers Paid subscription. Idle rooms are destroyed (`never_joined` / `idle` alarms, container `sleepAfter`).
R2/D1/Durable Objects are negligible at this scale (a 100 MB ROM costs $0.0015/month to store).
