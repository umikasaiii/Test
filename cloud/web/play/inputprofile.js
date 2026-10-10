// InputProfile: how a game is controlled, independent of the core. Chosen from the GameProfile; the touch layout, the keyboard map, the physical controller mapping and
// the core's controller device come from here. Adding a system means adding a profile (GB, GBA, SNES... would be a few lines each).
import { PLATFORMS } from "./coreregistry.js";

// RetroPad bit positions (RETRO_DEVICE_ID_JOYPAD_*), the same for every core: b y select start up down left right a x l r l2 r2 l3 r3
export const PAD_BITS = Object.freeze({ b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13, l3: 14, r3: 15 });

export const INPUT_PROFILES = Object.freeze({
  NDS_STANDARD: { id: "NDS_STANDARD", platform: PLATFORMS.NDS, touchLayout: "nds", buttons: ["b", "y", "select", "start", "up", "down", "left", "right", "a", "x", "l", "r"], analog: false, stylus: true, device: 1,
    keys: { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "b", x: "a", a: "y", s: "x", q: "l", w: "r", Enter: "start", Shift: "select" } },
  PS1_DIGITAL: { id: "PS1_DIGITAL", platform: PLATFORMS.PS1, touchLayout: "ps1", buttons: Object.keys(PAD_BITS), analog: false, stylus: false, device: 1,
    keys: { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "b", x: "a", a: "y", s: "x", q: "l", w: "r", e: "l2", r: "r2", Enter: "start", Shift: "select" } },
  PS1_DUALSHOCK: { id: "PS1_DUALSHOCK", platform: PLATFORMS.PS1, touchLayout: "ps1", buttons: Object.keys(PAD_BITS), analog: true, stylus: false, device: ((1 + 1) << 8) | 5,
    keys: { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "b", x: "a", a: "y", s: "x", q: "l", w: "r", e: "l2", r: "r2", Enter: "start", Shift: "select" } },
});
export const inputProfileFor = (gameProfile) => INPUT_PROFILES[gameProfile.inputProfile] || INPUT_PROFILES[gameProfile.platform === PLATFORMS.PS1 ? "PS1_DIGITAL" : "NDS_STANDARD"];
