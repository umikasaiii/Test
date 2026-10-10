// GameProfile: what the app knows about one game, whatever the system. The library, the Cloud metadata, presence and the invites use this; only the runtime resolver and the
// session know which core will run it. A profile is plain data (it is what meta.json stores, plus fields derived at load time).
import { PLATFORMS, PLATFORM_CORE, coreFor } from "./coreregistry.js";

/** @typedef {{gameId:string, id:string, title:string, platform:string, region:string, productCode:string, runtimeFamily:string, coreId:string,
 *   localAvailability:boolean, cloudAvailability:boolean, multiplayerCapabilities:{mode:string, localPlayers:number}, inputProfile:string, saveProfile:{kind:string, file:string, cloud:boolean},
 *   artworkMetadata:object|null, discMetadata:object|null, size:number, added:number}} GameProfile */

const hex = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** region from the product code: NDS codes end in a region letter, PlayStation serials start with the publisher/region prefix */
export function regionOf(platform, code) {
  const c = String(code || "").toUpperCase();
  if (platform === PLATFORMS.NDS) return { E: "NTSC-U", J: "NTSC-J", P: "PAL", D: "PAL", F: "PAL", I: "PAL", S: "PAL", K: "NTSC-K", U: "PAL", O: "NTSC-U", C: "NTSC-C" }[c[3]] || "UNKNOWN";
  if (platform === PLATFORMS.PS1) {
    if (/^(SLUS|SCUS|PAPX|PBPX|LSP|SLUD)/.test(c)) return "NTSC-U";
    if (/^(SLES|SCES|SCED|SLED|PEPX|PUPX|SLEH)/.test(c)) return "PAL";
    if (/^(SLPS|SLPM|SCPS|SCPM|PCPX|SIPS|SLPH|SCAJ|PAPX)/.test(c)) return "NTSC-J";
  }
  return "UNKNOWN";
}

/** id the Cloud knows the game by: platform + product code (stable across devices and regions of the same dump); PlayStation discs without a serial get a content based id */
export function gameIdOf(g) {
  if (!g) return "";
  const platform = String(g.platform || PLATFORMS.NDS).toUpperCase();
  if (platform === PLATFORMS.PS1) return g.serial ? "ps1-" + hex(g.serial) : g.cid ? "ps1-h" + hex(g.cid).slice(0, 10) : "";
  return g.code ? "nds-" + hex(g.code) : "";
}

/** @returns {GameProfile} from a stored meta.json (old DS entries have no platform: they are DS) */
export function profileOf(meta, { cloud = false } = {}) {
  const platform = String(meta.platform || PLATFORMS.NDS).toUpperCase();
  const core = coreFor(platform);
  const code = platform === PLATFORMS.PS1 ? meta.serial || "" : meta.code || "";
  const ps1 = platform === PLATFORMS.PS1;
  const discs = ps1 && Array.isArray(meta.discs) ? meta.discs : null;
  return {
    gameId: gameIdOf(meta), id: meta.id, title: meta.title || code || meta.id, platform, region: meta.region || regionOf(platform, code), productCode: code,
    runtimeFamily: platform, coreId: core ? core.id : "", localAvailability: true, cloudAvailability: !!cloud,
    multiplayerCapabilities: ps1 ? { mode: "none", localPlayers: 2 } : { mode: "distributed", localPlayers: 1 },
    inputProfile: ps1 ? (meta.analog ? "PS1_DUALSHOCK" : "PS1_DIGITAL") : "NDS_STANDARD",
    saveProfile: { kind: core ? core.saveKind : "sram", file: "save", cloud: true },
    artworkMetadata: meta.artwork || null,
    discMetadata: discs ? { count: discs.length, discs: discs.map((d, i) => ({ index: i, label: d.label || `Disco ${i + 1}`, file: d.file })), format: meta.format || "" } : null,
    size: meta.size || 0, added: meta.added || 0, analog: !!meta.analog, serial: meta.serial || "", code: meta.code || "", cid: meta.cid || "",
  };
}

/** metadata row pushed to the Cloud library (never files) */
export function cloudEntry(p) {
  const core = coreFor(p.platform);
  return { gameId: p.gameId, platform: p.platform.toLowerCase(), title: p.title, productCode: p.productCode || "", coreId: core ? core.cloudCoreId : "", multiplayerMode: p.multiplayerCapabilities.mode, downloadPlaySupported: false };
}
export const isPlatform = (p, name) => String(p && p.platform || PLATFORMS.NDS).toUpperCase() === name;
export { PLATFORMS, PLATFORM_CORE };
