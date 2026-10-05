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
      const s = svg('' +
        '<path class="arm" data-dir="up" d="M40 4h20a6 6 0 0 1 6 6v24H34V10a6 6 0 0 1 6-6z"/>' +
        '<path class="arm" data-dir="down" d="M40 96h20a6 6 0 0 0 6-6V66H34v24a6 6 0 0 0 6 6z"/>' +
        '<path class="arm" data-dir="left" d="M4 40v20a6 6 0 0 0 6 6h24V34H10a6 6 0 0 0-6 6z"/>' +
        '<path class="arm" data-dir="right" d="M96 40v20a6 6 0 0 1-6 6H66V34h24a6 6 0 0 1 6 6z"/>' +
        '<rect class="hub" x="34" y="34" width="32" height="32"/>' +
        '<path class="chev" d="M44 24l6-6 6 6M44 76l6 6 6-6M24 44l-6 6 6 6M76 44l6 6-6 6"/>', "0 0 100 100");
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
