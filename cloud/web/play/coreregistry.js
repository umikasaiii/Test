// PlaySphere core / runtime registry: the ONE place that says which emulation core runs which platform. Nothing else in the app switches on a core name.
// To add a system later (GB, GBC, GBA, NES, SNES, N64, PSP...) you add: one entry here + one CoreAdapter (a Player subclass, see gamesession.js) + one WebAssembly build
// + one InputProfile (inputprofile.js). The library, storage, saves, Cloud, social and Party Voice do not change. Those future platforms are NOT listed in the app: only the
// entries below with `available: true` are ever shown to the user.
//
// RUNTIMES is the enum of ways to run a game. Today every runtime is LOCAL (the game runs inside this page, in WebAssembly). It is deliberately a closed list that grows
// by adding names, so a different kind of runtime can be added without touching the rest.
export const RUNTIMES = Object.freeze({ LOCAL_NDS_WASM: "LOCAL_NDS_WASM", LOCAL_PS1_WASM: "LOCAL_PS1_WASM" });

export const PLATFORMS = Object.freeze({ NDS: "NDS", PS1: "PS1" });
/** documented, NOT available: the schema accepts these platform names so a game profile written by a future version is understood, never shown, never started */
export const FUTURE_PLATFORMS = Object.freeze(["NES", "SNES", "GB", "GBC", "GBA", "N64", "PSP"]);

/** a core adapter's contract: what the page must be able to do for it to run (DeviceCapabilities keys, see runtimeresolver.js) */
export const CORES = Object.freeze({
  "melonds": {
    id: "melonds", name: "melonDS DS", platform: PLATFORMS.NDS, runtime: RUNTIMES.LOCAL_NDS_WASM, available: true,
    worker: "./emulator.worker.js", requiredCapabilities: ["wasm", "moduleWorker"], optionalCapabilities: ["webgl2", "audioWorklet", "sab"],
    audioRate: 32768, saveKind: "sram", saveFile: "save", cloudCoreId: "melonds-ds", lazy: false,
  },
  "pcsx-rearmed": {
    id: "pcsx-rearmed", name: "PCSX-ReARMed", platform: PLATFORMS.PS1, runtime: RUNTIMES.LOCAL_PS1_WASM, available: true,
    worker: "./ps1.worker.js", requiredCapabilities: ["wasm", "wasmSimd", "moduleWorker"], optionalCapabilities: ["webgl2", "audioWorklet", "gamepad"],
    audioRate: 44100, saveKind: "memcard", saveFile: "save", cloudCoreId: "pcsx-rearmed", lazy: true,
    files: { js: "./core/ps1/playsphere_ps1.js", wasm: "./core/ps1/playsphere_ps1.wasm", info: "./core/ps1/build-info.json" },
    api: 1,                                   // the version of the message protocol between ps1.worker.js and the page; build-info.json carries the same number (stateFormat is separate)
  },
});

/** platform -> core id (the user never chooses a core) */
export const PLATFORM_CORE = Object.freeze({ [PLATFORMS.NDS]: "melonds", [PLATFORMS.PS1]: "pcsx-rearmed" });
export const coreFor = (platform) => CORES[PLATFORM_CORE[platform]] || null;
export const availablePlatforms = () => Object.keys(PLATFORM_CORE).filter((p) => coreFor(p) && coreFor(p).available);
