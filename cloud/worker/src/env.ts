import type { Presence } from "./presence";
import type { GameSession } from "./session";
import type { SignalRoom } from "./signal";

export interface Env {
  DB: D1Database;
  STORE: R2Bucket;                    // PRIVATE bucket: never public, never behind a custom domain
  PRESENCE: DurableObjectNamespace<Presence>;
  SESSION: DurableObjectNamespace<GameSession>;
  SIGNAL: DurableObjectNamespace<SignalRoom>;   // PWA <-> PWA signaling rooms (ephemeral)
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
  R2_ACCOUNT_ID?: string;             // optional: enables presigned direct-to-R2 uploads
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

export type Platform = "nds" | "ps1";
export interface User { id: string; username: string; display_name: string; avatar: string; created_at: number }
