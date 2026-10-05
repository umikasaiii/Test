// Short-lived WebRTC ICE servers (Cloudflare Realtime TURN). Cloudflare Containers accept NO inbound UDP from end users, so in production the
// media path is browser <-> Cloudflare TURN relay <-> container (the gateway allocates a relay as a TURN *client*). Credentials are minted here,
// with the TURN key secret that never leaves the Worker, and expire on their own.
import type { Env } from "./env";

export interface IceServer { urls: string | string[]; username?: string; credential?: string }

/** @param ttl seconds (Cloudflare allows up to 48 h) */
export async function mintIceServers(env: Env, ttl: number): Promise<IceServer[] | null> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: Math.min(Math.max(60, Math.floor(ttl)), 48 * 3600) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { iceServers?: IceServer[] };
    return Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : null;
  } catch { return null; }
}

/** ICE servers for a browser: minted TURN if configured, else the static ICE_SERVERS var, else public STUN. */
export async function browserIce(env: Env, ttl = 3600): Promise<IceServer[]> {
  const minted = await mintIceServers(env, ttl);
  if (minted) return minted;
  try { if (env.ICE_SERVERS) return JSON.parse(env.ICE_SERVERS); } catch { /* fall through */ }
  return [{ urls: "stun:stun.cloudflare.com:3478" }];
}
