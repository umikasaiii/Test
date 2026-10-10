import type { Presence } from "./presence";
import type { GameSession } from "./session";
import type { SignalRoom } from "./signal";
import type { PartyRoom } from "./partyroom";

export interface Env {
  DB: D1Database;
  STORE: R2Bucket;                    // PRIVATE bucket: never public, never behind a custom domain. OPTIONAL at runtime: absent when R2 is not enabled on the account (see needsStorage in index.ts)
  PRESENCE: DurableObjectNamespace<Presence>;
  SESSION: DurableObjectNamespace<GameSession>;
  SIGNAL: DurableObjectNamespace<SignalRoom>;   // PWA <-> PWA signaling rooms (ephemeral)
  PARTY: DurableObjectNamespace<PartyRoom>;     // Party Voice signaling (membership lives in D1; the DO only relays WebRTC signaling between members)
  CONTAINER?: DurableObjectNamespace;  // DSLinkContainer (production only)
  ASSETS?: Fetcher;
  DEV_GATEWAY?: string;                // dev/test only: local gateway standing in for the Container
  TURN_KEY_ID?: string;                // Cloudflare Realtime TURN key (credentials are minted per request, short-lived)
  TURN_KEY_API_TOKEN?: string;         // secret
  ICE_POLICY?: string;                 // "relay" forces browsers through TURN (tests / restrictive networks)
  ICE_SERVERS?: string;                // JSON array of RTCIceServer (TURN) handed to browsers
  RP_NAME: string;
  RP_ID: string;
  ORIGINS: string;                    // comma separated allowed origins (WebAuthn + CSRF check)
  ENVIRONMENT: string;
  INTERNAL_TOKEN: string;             // shared secret container <-> Worker
  DSLINK_STUN_URLS?: string;          // comma separated stun: URLs (default: public STUN)
  DSLINK_TURN_PROVIDER?: string;      // label only (reported in /api/realtime/ice policy)
  DSLINK_TURN_URLS?: string;          // comma separated turn:/turns: URLs of YOUR TURN server (coturn, ...)
  DSLINK_TURN_SECRET?: string;        // secret shared with the TURN server (use-auth-secret): credentials are derived from it per request, short-lived, and never leave the Worker
  DSLINK_TURN_USERNAME_MODE?: string; // "timestamp-user" (default: <expiry>:<opaque user tag>) or "timestamp" (<expiry>)
  DSLINK_TURN_TTL_SECONDS?: string;   // credential lifetime, default 3600
  QUOTA_MB?: string;                  // per-account Cloud storage quota in MB (default 2048)
  R2_ACCOUNT_ID?: string;             // optional: enables presigned direct-to-R2 uploads
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

export type Platform = "nds" | "ps1";
export interface User { id: string; username: string; display_name: string; avatar: string; created_at: number }
