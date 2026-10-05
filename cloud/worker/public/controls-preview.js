// Preview of the four approved layouts, rendered by the REAL components with neutral placeholder pictures (no game content).
// /controls-preview.html            -> the four layouts side by side (what is submitted for approval)
// /controls-preview.html?p=nds&o=landscape  -> one layout filling the window (interactive; used by the browser tests)
import { mountControls } from "/controls/controls.js";

function placeholder(platform) {
  const c = document.createElement("canvas");
  if (platform === "nds") {
    c.width = 256; c.height = 384; const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 192); sky.addColorStop(0, "#5aa6e8"); sky.addColorStop(1, "#bfe3ff"); g.fillStyle = sky; g.fillRect(0, 0, 256, 192);
    g.fillStyle = "#6fbf5a"; g.beginPath(); g.ellipse(60, 190, 120, 40, 0, Math.PI, 0); g.fill(); g.beginPath(); g.ellipse(200, 190, 110, 30, 0, Math.PI, 0); g.fill();
    g.fillStyle = "#e8d9b0"; g.fillRect(96, 90, 64, 70); g.fillStyle = "#c04a4a"; g.beginPath(); g.moveTo(88, 90); g.lineTo(128, 50); g.lineTo(168, 90); g.fill();
    g.fillStyle = "#2b3a52"; g.font = "bold 11px system-ui"; g.textAlign = "center"; g.fillText("SCHERMO SUPERIORE", 128, 20);
    g.fillStyle = "#ead8ae"; g.fillRect(0, 192, 256, 192); g.strokeStyle = "#9c8a5c"; g.lineWidth = 2;
    for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(40 + i * 44, 288 + (i % 2) * 16, 14, 0, 7); g.stroke(); }
    g.fillStyle = "#6b5b33"; g.fillText("SCHERMO TOUCH", 128, 212);
  } else {
    c.width = 320; c.height = 240; const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, 240); bg.addColorStop(0, "#0b2a2e"); bg.addColorStop(1, "#1a1030"); g.fillStyle = bg; g.fillRect(0, 0, 320, 240);
    g.fillStyle = "#0e4f56"; for (let i = 0; i < 8; i++) g.fillRect(20 + i * 36, 120 - (i % 3) * 22, 24, 120 + (i % 3) * 22);
    g.fillStyle = "#7fe0d0"; g.font = "bold 13px system-ui"; g.textAlign = "center"; g.fillText("SCHERMO DI GIOCO 4:3", 160, 24);
  }
  return c;
}

const q = new URLSearchParams(location.search);
const phoneMode = (platform, w, h, title, host) => {
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = `<h2></h2>`; card.firstChild.innerHTML = `${title}`;
  const phone = document.createElement("div"); phone.className = "phone"; const stage = document.createElement("div");
  stage.style.cssText = `width:${w}px;height:${h}px`; phone.append(stage); card.append(phone); host.append(card);
  return { stage, platform, w, h };
};

if (q.get("p")) {
  document.body.classList.add("single");
  const stage = document.createElement("div"); stage.id = "stage"; document.getElementById("app").append(stage);
  const events = (window.__events = []);
  const platform = q.get("p");
  window.__ctl = mountControls({ container: stage, video: placeholder(platform), platform, persist: false,
    sink: { btn: (k, d) => events.push(["btn", k, d]), stylus: (x, y, d, m) => events.push(["stylus", +x.toFixed(3), +y.toFixed(3), d, m]), ui: (n) => events.push(["ui", n]) },
    onLeave: () => events.push(["leave"]), insets: q.get("notch") ? { top: 0, bottom: 21, left: 47, right: 47 } : undefined });
} else {
  const grid = document.createElement("div"); grid.className = "grid"; document.getElementById("app").append(grid);
  const defs = [["nds", 390, 844, "1 · Nintendo DS · <span>Verticale</span>"], ["nds", 844, 390, "2 · Nintendo DS · <span>Orizzontale</span>"],
                ["ps1", 390, 844, "3 · PlayStation 1 · <span>Verticale</span>"], ["ps1", 844, 390, "4 · PlayStation 1 · <span>Orizzontale</span>"],
                ["nds", 844, 390, "2b · Nintendo DS · Orizzontale · <span>opzione «schermi più larghi» (immagine allungata)</span>", { stretch: true }]];
  for (const [p, w, h, t, extra] of defs) {
    const { stage } = phoneMode(p, w, h, t, grid);
    mountControls({ container: stage, video: placeholder(p), platform: p, persist: false, settings: { alpha: 1, scale: 1, haptics: true, stretch: false, ...(extra || {}) }, sink: { btn() {}, stylus() {}, ui() {} }, size: () => ({ width: w, height: h }), insets: {} });
  }
}
