// Multiplayer network profile of a game: how much latency its radio protocol tolerates. Data comes from cloud/web/play/netprofiles.json (shared with the PWA),
// so the decision is generic - the lobby never asks "is this Mario?", it asks the profile.
import rules from "../../web/play/netprofiles.json";

export type NetProfile = "LOW_LATENCY_REQUIRED" | "NORMAL" | "UNKNOWN";
const VALID = ["LOW_LATENCY_REQUIRED", "NORMAL", "UNKNOWN"];
interface Rule { productCode?: string; productCodePrefix?: string; profile: string }

export function profileOf(g: { productCode: string; downloadPlaySupported: boolean; override?: string }): NetProfile {
  if (g.override && VALID.includes(g.override)) return g.override as NetProfile;
  const code = (g.productCode || "").toUpperCase();
  for (const r of (rules as { rules: Rule[] }).rules) {
    if ((r.productCode && r.productCode.toUpperCase() === code) || (r.productCodePrefix && code.startsWith(r.productCodePrefix.toUpperCase()))) return r.profile as NetProfile;
  }
  if (g.downloadPlaySupported) return (rules as { downloadPlayProfile: string }).downloadPlayProfile as NetProfile;
  return (rules as { default: string }).default as NetProfile;
}
