// Link quality for Nintendo DS multiplayer over the Internet. Pure functions (unit tested in Node): no DOM, no WebRTC.
//
// REACHABILITY is not LATENCY. A TURN relay lets two peers behind NAT connect, it does not make a far connection fast enough for the DS wireless protocol:
// measured on the DS, ~0-8 ms one-way works, ~10 borderline, beyond that the game's own radio timeouts (RECV_TIMEOUT_MS stays 25) make it fail.
// So the lobby MEASURES first, classifies, and only then picks (or refuses to silently pick) a strategy.
//
// Levels (UX): OTTIMA (GREEN) · BUONA (YELLOW) · LIMITATA (ORANGE) · NON ADATTA (RED). Numbers never reach the normal UI (dev overlay only).
export const LABELS = { GREEN: "OTTIMA", YELLOW: "BUONA", ORANGE: "LIMITATA", RED: "NON ADATTA" };
export const PROFILES = ["LOW_LATENCY_REQUIRED", "NORMAL", "UNKNOWN"];
// Tolerance multiplier of the DS evidence thresholds per game profile: LOW_LATENCY_REQUIRED = the measured limits as they are; a tolerant game accepts more; an unmeasured one a prudent middle.
const SCALE = { LOW_LATENCY_REQUIRED: 1, UNKNOWN: 1.6, NORMAL: 2.5 };
// tiers [OTTIMA, BUONA, LIMITATA]; anything above the last is NON ADATTA
const T = { oneWay: [4, 8, 12], jitter: [2, 4, 8], spike: [6, 11, 16], loss: [0.2, 1, 3] };
const tier = (v, lim) => { for (let i = 0; i < lim.length; i++) if (v <= lim[i]) return i; return 3; };

/** @param {{received:number, rttAvg:number, rttP95?:number, jitter:number, lossPct:number}} pre  result of RadioPeer.preflight()/probe()
 *  @param {string} profile LOW_LATENCY_REQUIRED | NORMAL | UNKNOWN */
export function classify(pre, profile = "UNKNOWN") {
  if (!pre || !pre.received) return { level: "RED", label: LABELS.RED, oneWayMs: null, reasons: ["no_reply"] };
  const k = SCALE[profile] || SCALE.UNKNOWN, oneWay = pre.rttAvg / 2, spike = (pre.rttP95 || pre.rttAvg) / 2;
  const tiers = { oneWay: tier(oneWay, T.oneWay.map((x) => x * k)), jitter: tier(pre.jitter, T.jitter.map((x) => x * k)), spike: tier(spike, T.spike.map((x) => x * k)), loss: tier(pre.lossPct, T.loss) };
  const worst = Math.max(...Object.values(tiers)), level = ["GREEN", "YELLOW", "ORANGE", "RED"][worst];
  return { level, label: LABELS[level], oneWayMs: oneWay, reasons: Object.entries(tiers).filter(([, v]) => v === worst && worst > 0).map(([n]) => n) };
}

export const PATHS = { host: "direct", srflx: "srflx", prflx: "srflx", relay: "relay" };

/** What to do before START. mode: DIRECT_DISTRIBUTED | TURN_DISTRIBUTED. `block` = the user must decide (never start silently); `warn` = start allowed, with a note.
 *  @param {{path:string, quality:{level:string}, profile:string, hostedAvailable?:boolean}} i */
export function chooseMode(i) {
  const relay = i.path === "relay", lvl = i.quality ? i.quality.level : "RED", strict = i.profile === "LOW_LATENCY_REQUIRED";
  const mode = relay ? "TURN_DISTRIBUTED" : "DIRECT_DISTRIBUTED";
  const block = lvl === "RED" || (lvl === "ORANGE" && strict);
  const warn = !block && lvl === "ORANGE";
  const actions = block ? ["RETRY", "CONTINUE", ...(i.hostedAvailable ? ["HOSTED"] : [])] : [];
  const message = block ? "Questa connessione potrebbe non essere abbastanza veloce per il multiplayer Nintendo DS." : warn ? "La connessione è limitata: alcuni giochi potrebbero funzionare male." : "";
  return { mode, block, warn, actions, message, relay };
}

/** Longest radio gap a session survives after a network change (ICE restart in progress), by game profile. Longer than this the DS side has given up: end cleanly. */
export const OUTAGE_LIMIT_MS = { LOW_LATENCY_REQUIRED: 6000, UNKNOWN: 9000, NORMAL: 14000 };
export const outageLimit = (profile) => OUTAGE_LIMIT_MS[profile] || OUTAGE_LIMIT_MS.UNKNOWN;

/** profile of a game from the shared table (netprofiles.json, the same data the Cloud catalog uses): the lobby never asks "is this Mario?" */
export function profileFor(table, game) {
  if (!table || !game) return "UNKNOWN";
  if (game.networkProfile && PROFILES.includes(game.networkProfile)) return game.networkProfile;      // the Cloud catalog already decided
  const code = String(game.code || game.productCode || "").toUpperCase();
  for (const r of table.rules || []) {
    if ((r.productCode && r.productCode.toUpperCase() === code) || (r.productCodePrefix && code.startsWith(r.productCodePrefix.toUpperCase()))) return r.profile;
  }
  if (game.dlplay || game.downloadPlaySupported) return table.downloadPlayProfile || "LOW_LATENCY_REQUIRED";
  return table.default || "UNKNOWN";
}
