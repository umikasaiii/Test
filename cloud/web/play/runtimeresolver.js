// RuntimeResolver: GameProfile + DeviceCapabilities + UserPreferences -> RuntimeSelection. The user never picks a core, a WebAssembly file or an emulator:
// a DS game gets the DS core, a PlayStation game gets the PlayStation core. If this device cannot run the runtime the answer says so (no crash, no half start).
import { CORES, RUNTIMES, coreFor, FUTURE_PLATFORMS } from "./coreregistry.js";

/** WebAssembly SIMD (the PlayStation core's GPU needs it: Chrome 91+, Safari 16.4+, Firefox 89+) */
export function detectSimd() {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

/** Extend the page's capability report (player.js detectCaps) with what the cores ask for. */
export function deviceCapabilities(caps) {
  return { ...caps, wasmSimd: detectSimd(), gamepad: typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" };
}

const WHAT = { wasm: "WebAssembly", wasmSimd: "WebAssembly SIMD", moduleWorker: "Web Worker moderni" };

/**
 * @param profile GameProfile (platform is enough)
 * @param caps    DeviceCapabilities (deviceCapabilities())
 * @param prefs   UserPreferences (reserved: today nothing a user sets can change the runtime of a game, because there is only one per platform)
 * @returns {{ok:boolean, runtime:string|null, coreId:string|null, core:object|null, missing:string[], reason:string, optionalMissing:string[]}}
 */
export function resolveRuntime(profile, caps, prefs = {}) {
  const platform = String(profile && profile.platform || "NDS").toUpperCase();
  if (FUTURE_PLATFORMS.includes(platform)) return { ok: false, runtime: null, coreId: null, core: null, missing: [], optionalMissing: [], reason: "Questo sistema non è ancora disponibile in PlaySphere." };
  const core = coreFor(platform);
  if (!core || !core.available) return { ok: false, runtime: null, coreId: null, core: null, missing: [], optionalMissing: [], reason: "Sistema non riconosciuto." };
  const missing = core.requiredCapabilities.filter((k) => !caps[k]);
  const optionalMissing = core.optionalCapabilities.filter((k) => !caps[k]);
  if (missing.length) return { ok: false, runtime: core.runtime, coreId: core.id, core, missing, optionalMissing, reason: `Questo dispositivo non supporta questo runtime (${missing.map((k) => WHAT[k] || k).join(", ")}).` };
  return { ok: true, runtime: core.runtime, coreId: core.id, core, missing: [], optionalMissing, reason: "" };
}
export { RUNTIMES, CORES };
