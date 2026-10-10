// PlayStation extras around the (frozen) touch controls: they are added next to it, never inside it.
//  - menu section injected into the in-game menu sheet when MENU is pressed: disc swap, save states (1-5), DualShock analog switch, physical controller line
//  - floating analog sticks: appear only when the analog mode is on, on the left / right half of the picture; they never cover the buttons
import { h } from "./dom.js";

export const STATE_SLOTS = 5;
const fmtTime = (t) => new Date(t).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** @param ctx { container, controls, session, store, gameId (local id), profile, toast, setAnalogPref:(on)=>void, pad:()=>object|null } */
export function mountPs1Extras(ctx) {
  const { container, session, store, toast } = ctx;
  const stateKey = (n) => `library/${ctx.gameId}/state${n}`;

  // ---- floating sticks
  const sticks = { left: null, right: null };
  const layer = document.createElement("div"); layer.className = "ps1-sticks"; layer.hidden = true; container.append(layer);
  const mk = (side) => { const base = h("div", { class: "stk-base" }), knob = h("div", { class: "stk-knob" }); base.append(knob); base.style.display = "none"; layer.append(base); return { base, knob, id: null, ox: 0, oy: 0 }; };
  sticks.left = mk("left"); sticks.right = mk("right");
  const R = 56;
  const videoRect = () => { const v = ctx.controls.layout && ctx.controls.layout.screen && ctx.controls.layout.screen.video; if (!v) return null; const r = container.getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, w: v.w, h: v.h }; };
  const send = () => session.analog(Math.round(sticks.left.vx * 32767) || 0, Math.round(sticks.left.vy * 32767) || 0, Math.round(sticks.right.vx * 32767) || 0, Math.round(sticks.right.vy * 32767) || 0);
  sticks.left.vx = sticks.left.vy = sticks.right.vx = sticks.right.vy = 0;
  const onDown = (e) => {
    if (!session.analogOn || ctx.controls.router.ptr.has(e.pointerId)) return;                // analog off, or the touch belongs to a button
    const v = videoRect(); if (!v || e.clientX < v.x || e.clientX > v.x + v.w || e.clientY < v.y || e.clientY > v.y + v.h) return;
    const st = e.clientX < v.x + v.w / 2 ? sticks.left : sticks.right; if (st.id !== null) return;
    st.id = e.pointerId; st.ox = e.clientX; st.oy = e.clientY; const r = container.getBoundingClientRect();
    st.base.style.display = "block"; st.base.style.left = e.clientX - r.left - R + "px"; st.base.style.top = e.clientY - r.top - R + "px"; st.knob.style.transform = "translate(0,0)";
    try { container.setPointerCapture(e.pointerId); } catch { /* gone */ } e.preventDefault();
  };
  const onMove = (e) => {
    for (const st of [sticks.left, sticks.right]) if (st.id === e.pointerId) {
      let dx = e.clientX - st.ox, dy = e.clientY - st.oy; const d = Math.hypot(dx, dy); if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      st.knob.style.transform = `translate(${dx}px, ${dy}px)`; st.vx = dx / R; st.vy = dy / R; send();
    }
  };
  const onUp = (e) => { for (const st of [sticks.left, sticks.right]) if (st.id === e.pointerId) { st.id = null; st.vx = st.vy = 0; st.base.style.display = "none"; send(); } };
  container.addEventListener("pointerdown", onDown); container.addEventListener("pointermove", onMove); container.addEventListener("pointerup", onUp); container.addEventListener("pointercancel", onUp);
  const showSticks = (on) => { layer.hidden = !on; if (!on) for (const st of [sticks.left, sticks.right]) { st.id = null; st.vx = st.vy = 0; st.base.style.display = "none"; } };

  // ---- the menu section (the frozen menu sheet is opened by the controls; this runs right after and adds a block above "Riprendi")
  async function onMenu() {
    const sheet = container.querySelector(".ctl-menu .sheet"); if (!sheet || sheet.querySelector(".ps1-section")) return;
    const sec = h("div", { class: "ps1-section" });
    sec.append(h("h4", { text: "PlayStation" }));
    // analog
    const analog = h("input", { type: "checkbox" }); analog.checked = session.analogOn;
    analog.onchange = () => { session.setAnalog(analog.checked); showSticks(analog.checked); ctx.setAnalogPref(analog.checked); toast(analog.checked ? "Analogico attivo (DualShock)" : "Modalità digitale"); };
    sec.append(h("label", {}, h("div", { class: "row" }, h("span", { text: "Analogico (DualShock) · stick sullo schermo" }), analog)));
    // discs
    if (session.disc.count > 1) {
      const sel = h("select", { class: "sel" }); for (let i = 0; i < session.disc.count; i++) { const o = h("option", { value: String(i), text: ctx.profile.discMetadata.discs[i] ? ctx.profile.discMetadata.discs[i].label : `Disco ${i + 1}` }); if (i === session.disc.index) o.selected = true; sel.append(o); }
      const go = h("button", { text: "CAMBIA DISCO", "data-act": "disc" });
      go.onclick = async () => { go.disabled = true; go.textContent = "Cambio disco…"; const ok = await session.changeDisc(+sel.value); go.disabled = false; go.textContent = "CAMBIA DISCO"; toast(ok ? "Disco cambiato" : "Il disco non è cambiato"); };
      sec.append(h("label", {}, h("div", { class: "row" }, h("span", { text: "Disco" }), sel)), go);
    }
    // save states (not the game's memory card)
    const grid = h("div", { class: "ps1-states" });
    for (let n = 1; n <= STATE_SLOTS; n++) {
      let meta = null; try { const b = await store.get(stateKey(n) + ".json"); if (b) meta = JSON.parse(new TextDecoder().decode(b)); } catch { /* none */ }
      const save = h("button", { class: "mini", text: "SALVA", "data-act": "state-save", "data-slot": String(n) }), load = h("button", { class: "mini", text: "CARICA", "data-act": "state-load", "data-slot": String(n) });
      load.disabled = !meta;
      save.onclick = async () => {
        const r = await session.saveState(); if (r.error) { toast("Stato non salvato"); return; }
        const m = { core: r.core, coreVersion: r.coreVersion, stateFormat: r.stateFormat, size: r.size, t: Date.now() };
        try { await store.put(stateKey(n), r.data); await store.put(stateKey(n) + ".json", new TextEncoder().encode(JSON.stringify(m)).buffer); toast(`Stato ${n} salvato`); load.disabled = false; info.textContent = `${n}: ${fmtTime(m.t)}`; }
        catch { toast("Spazio del browser esaurito"); }
      };
      load.onclick = async () => {
        const raw = await store.get(stateKey(n)); const mb = await store.get(stateKey(n) + ".json"); let m = null; try { m = JSON.parse(new TextDecoder().decode(mb)); } catch { /* none */ }
        if (!raw || !m) { toast("Nessuno stato in questo slot"); return; }
        const r = await session.loadState(raw, m);
        toast(r.ok ? `Stato ${n} caricato` : r.error === "incompatible" ? "Questo stato è di un'altra versione del core: non viene caricato" : "Stato non caricato");
      };
      const info = h("small", { class: "hint", text: meta ? `${n}: ${fmtTime(meta.t)}` : `${n}: vuoto` });
      grid.append(h("div", { class: "ps1-slot" }, h("b", { text: String(n) }), save, load, info));
    }
    sec.append(h("p", { class: "hint", text: "Gli stati sono diversi dal salvataggio del gioco (memory card): restano su questo dispositivo." }), grid);
    // controller
    const pad = ctx.pad(); sec.append(h("p", { class: "hint", text: pad ? `Controller: ${pad.id.slice(0, 40)}${pad.rumble ? " · vibrazione" : ""}` : "Controller fisico: nessuno collegato" }));
    sheet.insertBefore(sec, sheet.querySelector('[data-act="resume"]'));
  }
  return { onMenu, showSticks, destroy() { container.removeEventListener("pointerdown", onDown); container.removeEventListener("pointermove", onMove); container.removeEventListener("pointerup", onUp); container.removeEventListener("pointercancel", onUp); layer.remove(); } };
}
