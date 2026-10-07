// Device tuning knobs for the player (render path, audio backend, latency hint, development overlay). Order: URL parameter > this device's saved choice (localStorage) > default.
// They exist so a phone can be A/B-tested from the "Impostazioni di test" panel without editing URLs. Nothing here is sent anywhere.
const KEY = "dslink.opts";
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } };
export function opt(name, def = "auto") {
  const u = new URLSearchParams(location.search).get(name); if (u !== null) return u;
  const v = read()[name]; return v === undefined || v === null || v === "" ? def : v;
}
export function setOpt(name, value) { try { const o = read(); if (value === "auto" || value === "" || value == null) delete o[name]; else o[name] = value; localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage blocked: the choice lasts until reload only */ } }
