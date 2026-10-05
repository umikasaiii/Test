// In-game menu sheet (opened by the MENU button): resume, control opacity/size, haptics, leave. Settings live in localStorage (per device, never sent anywhere).
export const DEFAULTS = { alpha: 1, scale: 1, haptics: true, stretch: false };
const KEY = "dslink.controls.v1";
export function loadSettings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULTS }; } }
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

export function openMenu(container, { settings, onChange, onResume, onLeave, title = "Menu" }) {
  const wrap = document.createElement("div"); wrap.className = "ctl-menu"; wrap.setAttribute("role", "dialog");
  const sheet = document.createElement("div"); sheet.className = "sheet";
  const h = document.createElement("h3"); h.textContent = title;
  const range = (label, key, min, max, step) => {
    const l = document.createElement("label"); const row = document.createElement("div"); row.className = "row";
    const t = document.createElement("span"); t.textContent = label; const v = document.createElement("span");
    const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = settings[key]; i.dataset.key = key;
    const show = () => (v.textContent = key === "alpha" ? `${Math.round(i.value * 100)}%` : `${Math.round(i.value * 100)}%`); show();
    i.addEventListener("input", () => { settings[key] = Number(i.value); show(); onChange(settings); });
    row.append(t, v); l.append(row, i); return l;
  };
  const toggle = (label, key) => {
    const l = document.createElement("label"); const row = document.createElement("div"); row.className = "row";
    const t = document.createElement("span"); t.textContent = label; const i = document.createElement("input"); i.type = "checkbox"; i.checked = !!settings[key]; i.dataset.key = key;
    i.addEventListener("change", () => { settings[key] = i.checked; onChange(settings); }); row.append(t, i); l.append(row); return l;
  };
  const resume = document.createElement("button"); resume.className = "primary"; resume.textContent = "Riprendi"; resume.dataset.act = "resume";
  const leave = document.createElement("button"); leave.className = "danger"; leave.textContent = "Esci dalla partita"; leave.dataset.act = "leave";
  resume.onclick = () => { wrap.remove(); onResume(); };
  leave.onclick = () => { wrap.remove(); onLeave(); };
  sheet.append(h, range("Opacità controlli", "alpha", 0.25, 1, 0.05), range("Dimensione controlli", "scale", 0.85, 1.15, 0.05), toggle("Vibrazione al tocco", "haptics"), toggle("Schermi più larghi (allunga l'immagine)", "stretch"), resume, leave);
  wrap.append(sheet); container.append(wrap);
  return { close() { wrap.remove(); } };
}
