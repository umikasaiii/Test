// Realtime ICE configuration for the PWA (game DataChannel + Party Voice). The PWA never contains a TURN user, password or secret:
// this endpoint (authenticated, rate limited) derives SHORT-LIVED credentials per request from secrets that stay in the Worker.
//   STUN : DSLINK_STUN_URLS (default: public STUN)
//   TURN : DSLINK_TURN_URLS + DSLINK_TURN_SECRET  - the coturn "use-auth-secret" scheme: username = <expiry>[:<opaque user tag>], credential = base64(HMAC-SHA1(secret, username))
//   TURN : Cloudflare Realtime TURN (TURN_KEY_ID + TURN_KEY_API_TOKEN) when configured
// Nothing configured for TURN -> STUN only, and the answer says so (policy.relayAvailable=false) so the UI can say "relay non disponibile" instead of guessing.
import type { Env, User } from "./env";
import { json, now } from "./util";
import { limit } from "./ratelimit";
import { mintIceServers, type IceServer } from "./turn";

const DEFAULT_STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: ArrayBuffer) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s); };

async function hmac(hash: "SHA-1" | "SHA-256", secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

export const turnConfigured = (env: Env) => list(env.DSLINK_TURN_URLS).some((u) => /^turns?:/i.test(u)) && !!env.DSLINK_TURN_SECRET;

/** coturn REST-style ephemeral credential (also what a self hosted TURN with `use-auth-secret` expects) */
export async function turnCredential(env: Env, userId: string, ttlSeconds: number, at = now()) {
  const exp = Math.floor(at / 1000) + ttlSeconds, secret = env.DSLINK_TURN_SECRET!;
  const mode = env.DSLINK_TURN_USERNAME_MODE === "timestamp" ? "timestamp" : "timestamp-user";
  const username = mode === "timestamp" ? String(exp) : `${exp}:${hex(await hmac("SHA-256", secret, "user:" + userId)).slice(0, 12)}`;   // an opaque tag: the TURN log cannot be mapped back to the account
  return { username, credential: b64(await hmac("SHA-1", secret, username)), expiresAt: exp * 1000, mode };
}

export async function iceFor(env: Env, user: User) {
  const ttl = Math.min(Math.max(300, Number(env.DSLINK_TURN_TTL_SECONDS) || 3600), 24 * 3600);
  const stun = list(env.DSLINK_STUN_URLS).filter((u) => /^stuns?:/i.test(u));
  const iceServers: IceServer[] = [{ urls: stun.length ? stun : DEFAULT_STUN }];
  const providers = ["stun"]; let expiresAt = now() + ttl * 1000, mode = "";
  if (turnConfigured(env)) {
    const c = await turnCredential(env, user.id, ttl);
    iceServers.push({ urls: list(env.DSLINK_TURN_URLS).filter((u) => /^turns?:/i.test(u)), username: c.username, credential: c.credential });
    providers.push("turn-secret"); expiresAt = c.expiresAt; mode = c.mode;
  }
  const cf = await mintIceServers(env, ttl);
  if (cf) { iceServers.push(...cf); providers.push("cloudflare-turn"); }
  const relay = providers.length > 1;
  return {
    iceServers, issuedAt: now(), expiresAt, ttlSeconds: ttl,
    policy: { relayAvailable: relay, stunOnly: !relay, providers, iceTransportPolicy: env.ICE_POLICY === "relay" ? "relay" : "all" },
    metadata: { usernameMode: mode || null },
  };
}

export async function handleRealtime(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  if (path === "/api/realtime/ice" && req.method === "GET") {
    limit(user.id, "ice", 40);                                           // a page asks once per session and on expiry: 40 per 10 minutes is generous
    return json(await iceFor(env, user), 200, { "cache-control": "no-store" });
  }
  return null;
}
