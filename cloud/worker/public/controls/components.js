// DSLink touch controls — VISUAL COMPONENTS (DOM/SVG only; no input logic, no layout logic).
// Every control is `.ctl-c` with data-id; its pressed state is the class `is-down` (cluster faces / pad arms carry their own).

const NS = "http://www.w3.org/2000/svg";
const svg = (inner, vb = "0 0 24 24") => { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", vb); s.setAttribute("aria-hidden", "true"); s.innerHTML = inner; return s; };

export const ICONS = {
  menu: '<path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  minus: '<path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  swap: '<path d="M7 8h10l-2.6-2.6M17 16H7l2.6 2.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  expand: '<rect x="6" y="6" width="12" height="12" rx="2.2" stroke="currentColor" stroke-width="2.2" fill="none"/>',
};
export const SYMBOLS = {      // PlayStation face symbols
  triangle: '<path d="M12 5.2 19.2 18H4.8z" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" fill="none"/>',
  circle: '<circle cx="12" cy="12" r="6.6" stroke="currentColor" stroke-width="2.4" fill="none"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1.6" stroke="currentColor" stroke-width="2.4" fill="none"/>',
};
export const FACE_COLORS = {   // light accents on the action buttons
  nds: { x: "#59c8ff", a: "#ff5d6e", b: "#ffd24d", y: "#4fe3a6" },
  ps1: { x: "#3fe0c5", a: "#ff5d6e", b: "#5aa8ff", y: "#e279e6" },
};

const el = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

let dpadSeq = 0;
export function buildControl(c) {
  const root = el("div", `ctl-c ctl-${c.type}`, { "data-id": c.id });
  switch (c.type) {
    case "shoulder": root.append(el("span", "ctl-label")); root.firstChild.textContent = c.label; break;
    case "pill": {
      const b = el("div", "ctl-pillbtn"); b.append(svg(ICONS[c.icon]));
      const l = el("span", "ctl-micro"); l.textContent = c.label;
      root.append(b, l); break;
    }
    case "dpad": {
      // ONE plus-shaped silhouette like the approved artwork: pale glowing rim, blue-navy glass body (lighter at the arm tips), dark centre dimple, faint round halo.
      // The four `.arm` overlays are clipped to the silhouette and only show the pressed direction.
      const u = ++dpadSeq, PLUS = "M42 4H58A7 7 0 0 1 65 11V32A3 3 0 0 0 68 35H89A7 7 0 0 1 96 42V58A7 7 0 0 1 89 65H68A3 3 0 0 0 65 68V89A7 7 0 0 1 58 96H42A7 7 0 0 1 35 89V68A3 3 0 0 0 32 65H11A7 7 0 0 1 4 58V42A7 7 0 0 1 11 35H32A3 3 0 0 0 35 32V11A7 7 0 0 1 42 4Z";
      const s = svg(`<defs><clipPath id="dpc${u}"><path d="${PLUS}"/></clipPath>` +
        `<radialGradient id="dpg${u}" cx="50%" cy="50%" r="55%"><stop offset="0" stop-color="#0a1430" stop-opacity=".92"/><stop offset=".38" stop-color="#14245a" stop-opacity=".74"/><stop offset="1" stop-color="#2f4d9a" stop-opacity=".62"/></radialGradient></defs>` +
        `<circle class="halo" cx="50" cy="50" r="47"/>` +
        `<path class="shape" d="${PLUS}" fill="url(#dpg${u})"/>` +
        `<g clip-path="url(#dpc${u})">` +
        `<rect class="arm" data-dir="up" x="35" y="0" width="30" height="46"/><rect class="arm" data-dir="down" x="35" y="54" width="30" height="46"/>` +
        `<rect class="arm" data-dir="left" x="0" y="35" width="46" height="30"/><rect class="arm" data-dir="right" x="54" y="35" width="46" height="30"/></g>` +
        `<circle class="dimple" cx="50" cy="50" r="7"/>`, "0 0 100 100");
      root.append(s); break;
    }
    case "cluster": {
      root.dataset.platform = c.platform;
      for (const f of c.faces) {
        const b = el("div", `ctl-face face-${f.pos}`, { "data-face": f.id });
        b.style.setProperty("--accent", FACE_COLORS[c.platform][f.id]);
        if (c.platform === "ps1") b.append(svg(SYMBOLS[f.glyph])); else { const t = el("span", "ctl-glyph"); t.textContent = f.glyph; b.append(t); }
        root.append(b);
      }
      break;
    }
  }
  return root;
}

/** places a control's element at its VISIBLE layout rectangle (the larger touch area is handled by the input router from the same layout data) */
export function placeControl(node, c, scale) {
  const st = node.style;
  st.left = `${c.x}px`; st.top = `${c.y}px`; st.width = `${c.w}px`; st.height = `${c.h}px`;
  st.setProperty("--k", String(scale));                          // 1 = reference size; text/icons/glow scale with it
  if (c.type === "pill") { st.setProperty("--pill", `${c.vis}px`); st.setProperty("--hit", `${c.w}px`); }
}
