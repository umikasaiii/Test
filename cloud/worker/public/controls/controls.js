// DSLink touch controls — CONTROLLER: glues the pure layout (layouts.js), the visuals (components.js) and the input router (input.js) to a video element.
// mountControls({ container, video, platform, sink }) -> { relayout, setView, setSettings, openMenu, destroy, layout }
// sink = { btn(name, down), stylus(x, y, down, move), ui?(name), leave?() }   x,y: normalised over the WHOLE DS frame (both screens)
import { computeLayout } from "./layouts.js";
import { buildControl, placeControl } from "./components.js";
import { InputRouter } from "./input.js";
import { loadSettings, saveSettings, openMenu } from "./menu.js";

export function mountControls({ container, video, platform = "nds", sink, insets, settings = loadSettings(), persist = true, onLeave = () => {}, size }) {
  container.classList.add("ctl-stage");
  const clip = document.createElement("div"); clip.className = "ctl-clip";
  clip.append(video);
  const overlay = document.createElement("div"); overlay.className = "ctl-overlay";
  container.append(clip, overlay);

  const nodes = new Map();
  let view = "both", layout = null, menu = null, immersive = false, awake = false, wakeTimer = 0, destroyed = false;
  const IMMERSIVE_ALPHA = 0.1, WAKE_MS = 2500;                      // PS1 aux key: controls almost hidden, back at full opacity on touch
  const alphaNow = () => (immersive && !awake ? Math.min(settings.alpha, IMMERSIVE_ALPHA) : settings.alpha);
  const visual = (id, sub, down) => {
    const n = nodes.get(id); if (!n) return;
    if (sub) { const part = n.querySelector(`[data-dir="${sub}"], [data-face="${sub}"]`); if (part) part.classList.toggle("is-down", down); }
    else { const target = n.classList.contains("ctl-pill") ? n.querySelector(".ctl-pillbtn") : n; target.classList.toggle("is-down", down); }
  };
  const router = new InputRouter({
    sink: { btn: (k, d) => sink.btn(k, d), stylus: (x, y, d, m) => sink.stylus(x, y, d, m), ui: (n) => doUi(n) },
    onVisual: visual, haptics: () => settings.haptics,
  });

  const readInsets = () => {
    if (insets) return insets;
    const p = document.createElement("div"); p.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(p); const cs = getComputedStyle(p); const r = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 }; p.remove(); return r;
  };
  const dims = () => (size ? size() : { width: container.clientWidth, height: container.clientHeight });

  function relayout() {
    if (destroyed) return;
    const { width, height } = dims();
    layout = computeLayout({ platform, width, height, insets: readInsets(), view, fill: settings.stretch, userScale: settings.scale });
    container.dataset.orientation = layout.orientation; container.dataset.variant = layout.variant; container.dataset.platform = platform;
    container.style.setProperty("--ctl-alpha", String(alphaNow()));
    const cl = layout.screen.clip, v = layout.screen.video;
    Object.assign(clip.style, { left: `${cl.x}px`, top: `${cl.y}px`, width: `${cl.w}px`, height: `${cl.h}px` });
    Object.assign(video.style, { left: `${v.x - cl.x}px`, top: `${v.y - cl.y}px`, width: `${v.w}px`, height: `${v.h}px`, objectFit: "fill" });
    const seen = new Set();
    for (const c of layout.controls) {
      seen.add(c.id);
      let n = nodes.get(c.id);
      if (!n) { n = buildControl(c); nodes.set(c.id, n); overlay.append(n); }
      placeControl(n, c, layout.scale);
    }
    for (const [id, n] of [...nodes]) if (!seen.has(id)) { n.remove(); nodes.delete(id); }
    nodes.get("focus")?.classList.toggle("is-active", view !== "both" || immersive);
    const r = container.getBoundingClientRect();
    router.setLayout(layout, { x: r.left, y: r.top });
  }

  function doUi(name) {
    if (name === "menu") { api.openMenu(); }
    else if (name === "focus") {
      if (platform === "nds") { view = view === "both" ? "bottom" : view === "bottom" ? "top" : "both"; }
      else { immersive = !immersive; awake = false; clearTimeout(wakeTimer); }
      relayout();
    }
    sink.ui?.(name);
  }

  const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); return () => t.removeEventListener(ev, fn, opt); };
  const wake = () => { if (!immersive) return; awake = true; container.style.setProperty("--ctl-alpha", String(alphaNow())); clearTimeout(wakeTimer); wakeTimer = setTimeout(() => { awake = false; if (!destroyed) container.style.setProperty("--ctl-alpha", String(alphaNow())); }, WAKE_MS); };
  const offs = [
    on(container, "pointerdown", wake, true),
    on(container, "pointerdown", (e) => { if (menu) return; if (router.down(e)) { try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ } e.preventDefault(); } }),
    on(container, "pointermove", (e) => router.move(e)),
    on(container, "pointerup", (e) => router.up(e)),
    on(container, "pointercancel", (e) => router.up(e)),
    on(container, "lostpointercapture", (e) => router.up(e)),
    on(container, "contextmenu", (e) => e.preventDefault()),
    on(window, "blur", () => router.releaseAll()),
    on(document, "visibilitychange", () => { if (document.hidden) router.releaseAll(); }),
    on(window, "pagehide", () => router.releaseAll()),
    on(window, "resize", relayout), on(window, "orientationchange", () => setTimeout(relayout, 120)),
  ];

  const api = {
    get layout() { return layout; },
    relayout,
    setView(v) { view = v; relayout(); },
    setSettings(next) { Object.assign(settings, next); if (persist) saveSettings(settings); relayout(); },
    openMenu() {
      router.releaseAll(); menu?.close();
      menu = openMenu(container, { settings, onChange: (s) => { Object.assign(settings, s); if (persist) saveSettings(settings); relayout(); }, onResume: () => { menu = null; }, onLeave: () => { menu = null; onLeave(); } });
    },
    destroy() { destroyed = true; clearTimeout(wakeTimer); router.releaseAll(); offs.forEach((f) => f()); menu?.close(); overlay.remove(); clip.remove(); container.classList.remove("ctl-stage"); },
    router,
  };
  relayout();
  return api;
}
