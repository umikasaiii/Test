// Internet networking helpers for the PWA: ICE configuration from the Cloud (short-lived TURN credentials, never stored in the app) and the path a WebRTC connection really uses.
import { PATHS } from "./netquality.js";

const STUN_DEFAULT = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
let cache = null;

/** ICE servers for a game or voice connection. Logged in: GET /api/realtime/ice (authenticated, expires, STUN + TURN if the Cloud has one). Anonymous / Cloud unreachable: public STUN only.
 *  `?ice=relay` is a developer override (force the relay path to test it); `?stun=0` removes STUN (LAN only). */
export async function loadIce(cloud, opt) {
  const policy = opt && opt("ice", "") === "relay" ? "relay" : "all";
  if (opt && opt("stun", "1") === "0") return { iceServers: [], iceTransportPolicy: policy, relayAvailable: false, expiresAt: 0, source: "none" };
  if (cache && cache.user === (cloud && cloud.user && cloud.user.userId) && cache.expiresAt - Date.now() > 60_000) return { ...cache.v, iceTransportPolicy: policy };
  if (cloud && cloud.state === "user") {
    const r = await cloud.api("GET", "/api/realtime/ice");
    if (r.ok && Array.isArray(r.body.iceServers)) {
      const v = { iceServers: r.body.iceServers, iceTransportPolicy: policy, relayAvailable: !!(r.body.policy && r.body.policy.relayAvailable), expiresAt: r.body.expiresAt, source: "cloud" };
      cache = { user: cloud.user.userId, expiresAt: r.body.expiresAt, v }; return v;
    }
  }
  return { iceServers: STUN_DEFAULT, iceTransportPolicy: policy, relayAvailable: false, expiresAt: Date.now() + 300_000, source: "default" };
}
export const forgetIce = () => { cache = null; };

/** which path the connection really uses: direct (both host candidates: same network), srflx (peer to peer through NAT, STUN), relay (TURN) + the raw candidate types */
export async function selectedPath(pc) {
  try {
    const stats = await pc.getStats(); let pair = null; const byId = new Map(); stats.forEach((s) => byId.set(s.id, s));
    stats.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId) || pair; });
    if (!pair) stats.forEach((s) => { if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) pair = s; });
    if (!pair) return { path: "unknown", local: "", remote: "", protocol: "", rtt: 0 };
    const l = byId.get(pair.localCandidateId) || {}, r = byId.get(pair.remoteCandidateId) || {};
    const lt = l.candidateType || "", rt = r.candidateType || "";
    const path = lt === "relay" || rt === "relay" ? "relay" : lt === "host" && rt === "host" ? "direct" : PATHS[lt] || PATHS[rt] || "srflx";
    return { path, local: lt, remote: rt, protocol: l.protocol || "", relayProtocol: l.relayProtocol || "", rtt: (pair.currentRoundTripTime || 0) * 1000 };
  } catch { return { path: "unknown", local: "", remote: "", protocol: "", rtt: 0 }; }
}
