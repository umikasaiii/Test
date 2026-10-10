// PlaySphere app shell (FASE 9): theme, navigation, Home, Library extras, Game detail, first run, install / offline / update hints, haptics, friendly errors, session restore.
// It sits ON TOP of the existing screens: every id the older code and tests use is still there; this module only decides what is visible and how it is presented.
// Nothing here touches the emulator: while a game runs the shell is idle (no timers, no animations, no layout work).
import { h } from "./dom.js";

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked: the preference just is not remembered */ } },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};
const TABS = ["home", "games", "multiplayer", "settings"];
const NAV_SCREENS = new Set(["library", "friends", "profile", "party", "cloudlib"]);
const SUB_BACK = { lobby: "btnLobbyLeave", "friends-create": "btnCreateBack", "friends-join": "btnJoinBack", account: "btnAuthBack", error: "btnErrBack", lost: "btnLostBack" };
const ICON = (id, cls = "") => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("aria-hidden", "true"); if (cls) s.setAttribute("class", cls); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-" + id); s.append(u); return s; };
const hash32 = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
const ago = (t) => { const d = Date.now() - t, m = Math.round(d / 60000); if (m < 1) return "adesso"; if (m < 60) return m + " min fa"; const hh = Math.round(m / 60); if (hh < 24) return hh + (hh === 1 ? " ora fa" : " ore fa"); const dd = Math.round(hh / 24); return dd === 1 ? "ieri" : dd + " giorni fa"; };
export const platformLabel = (p) => (p === "PS1" ? "PS1" : "DS");
export const platformName = (p) => (p === "PS1" ? "PlayStation" : "Nintendo DS");

/** how a failure is explained to the user: what happened, what to do. The raw text never reaches the screen, except in a collapsed "Dettagli tecnici" (first line only, no stack). */
const ERRORS = [
  [/disco non trovato|gioco non trovato|file mancante|manca il file/i, { title: "File mancante", what: "PlaySphere non trova più i file di questo gioco su questo dispositivo.", todo: "Aggiungi di nuovo il gioco dalla Libreria. I tuoi salvataggi non vengono toccati." }],
  [/bios|firmware/i, { title: "Manca un file di sistema", what: "Questo gioco ha bisogno di un file di sistema (BIOS o firmware) che non è su questo dispositivo.", todo: "Aggiungilo da Impostazioni › File di sistema, oppure recuperalo dal tuo Cloud." }],
  [/non supporta questo runtime|non supporta|webassembly|simd/i, { title: "Dispositivo non compatibile", what: "Questo browser o dispositivo non può far girare il sistema di questo gioco.", todo: "Aggiorna Chrome o Safari all'ultima versione, oppure prova da un altro dispositivo." }],
  [/quota|spazio|storage full|local_quota/i, { title: "Spazio esaurito", what: "Il dispositivo non ha abbastanza spazio libero per completare l'operazione.", todo: "Libera spazio (rimuovi un gioco che non usi) e riprova. Niente è stato perso." }],
  [/scarica|download|fetch|network|rete/i, { title: "Download non riuscito", what: "Il file non è arrivato per intero.", todo: "Controlla la connessione e riprova. Nel tuo Cloud il file è al sicuro." }],
  [/cloud/i, { title: "Cloud non raggiungibile", what: "PlaySphere non riesce a contattare il tuo Cloud in questo momento.", todo: "I giochi su questo dispositivo funzionano comunque. Riprova più tardi." }],
];
const GENERIC = { title: "Il gioco si è fermato", what: "Qualcosa è andato storto e PlaySphere ha chiuso il gioco in sicurezza.", todo: "Torna alla Libreria e riavvia il gioco. Il salvataggio su questo dispositivo è al sicuro." };
export function explain(msg) {
  const text = String(msg || ""); for (const [re, e] of ERRORS) if (re.test(text)) return e; return GENERIC;
}

export function initShell(ctx) {
  const { $ } = ctx;
  const root = document.documentElement, body = document.body;
  let tab = "home", detailFor = null, lastFocus = null, welcomeIdx = 0, deferredInstall = null, mpSeg = LS.get("ps.mp", "local");
  const state = { q: "", lib: "all", loc: "all" };

  // ================================================================= preferences: theme, effects, haptics
  const lite = () => body.classList.contains("ps-lite");
  function applyTheme(pref) {
    const mq = matchMedia("(prefers-color-scheme: light)"); const theme = pref === "system" ? (mq.matches ? "light" : "dark") : pref === "light" ? "light" : "dark";
    root.setAttribute("data-theme", theme); root.setAttribute("data-theme-pref", pref); const m = $("metaTheme"); if (m) m.setAttribute("content", theme === "light" ? "#e9f2ff" : "#060b17");
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.themeSet === pref)));
  }
  function initPrefs() {
    body.classList.toggle("ps-lite", !!root._lite);
    const pref = root.getAttribute("data-theme-pref") || "dark"; applyTheme(pref);
    document.querySelectorAll("[data-theme-set]").forEach((b) => { b.onclick = () => { LS.set("ps.theme", b.dataset.themeSet); applyTheme(b.dataset.themeSet); haptic(8); }; });
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if ((root.getAttribute("data-theme-pref") || "dark") === "system") applyTheme("system"); });
    const L = $("optLite"); L.checked = lite(); L.onchange = () => { LS.set("ps.lite", L.checked ? "1" : "0"); body.classList.toggle("ps-lite", L.checked); };
    const H = $("optHaptic"); H.checked = LS.get("ps.haptic", "1") === "1"; H.onchange = () => { LS.set("ps.haptic", H.checked ? "1" : "0"); if (H.checked) haptic(12); };
    const G = $("optHapticGame"); G.checked = LS.get("ps.hapticGame", "0") === "1"; G.onchange = () => { LS.set("ps.hapticGame", G.checked ? "1" : "0"); };
    if (!("vibrate" in navigator)) { H.closest(".ps-line").hidden = true; G.closest(".ps-line").hidden = true; }
  }
  /** light vibration where the platform has it (Android Chrome); never continuous, never while the user turned it off */
  function haptic(ms = 10) { try { if (navigator.vibrate && LS.get("ps.haptic", "1") === "1") navigator.vibrate(ms); } catch { /* not allowed */ } }
  // in-game button feedback is opt-in: it must never cost input latency for people who did not ask for it
  addEventListener("pointerdown", (e) => { if (body.dataset.screen === "game" && LS.get("ps.hapticGame", "0") === "1" && e.target.closest && e.target.closest(".ctl-face, .ctl-shoulder, .ctl-pillbtn, .ctl-dpad")) { try { navigator.vibrate && navigator.vibrate(6); } catch { /* ok */ } } }, { passive: true, capture: true });

  // ================================================================= cover, favourites, recent
  const favs = () => new Set(LS.json("ps.fav", []));
  const recent = () => LS.json("ps.recent", {});
  const isFav = (g) => { if (favs().has(g.id)) return true; const e = ctx.cloudEntry(g); return !!(e && e.favorite); };
  function setFav(g, on) {
    const f = favs(); if (on) f.add(g.id); else f.delete(g.id); LS.set("ps.fav", JSON.stringify([...f]));
    const e = ctx.cloudEntry(g); if (e && ctx.cloud && ctx.cloud.state === "user") ctx.cloud.setFavorite(e.gameId, on).catch(() => {});
  }
  function played(id) { const r = recent(); r[id] = Date.now(); const keep = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 40); LS.set("ps.recent", JSON.stringify(Object.fromEntries(keep))); }
  function cover(title, platform, extra = "") {
    const t = String(title || "?").trim(); const mono = (t.match(/[A-Za-zÀ-ÿ0-9]/g) || ["?"]).slice(0, 2).join("").toUpperCase();
    return h("span", { class: "ps-cover " + extra, "data-h": String(hash32(t) % 6), "aria-hidden": "true" }, h("span", { class: "mono", text: mono }), h("span", { class: "shade" }), h("span", { class: "plat", text: platformLabel(platform) }));
  }
  function favButton(g) {
    const b = h("button", { class: "ps-fav", type: "button", "aria-pressed": String(isFav(g)), "aria-label": "Preferito" }); b.append(ICON("heart"));
    b.onclick = (ev) => { ev.stopPropagation(); const on = b.getAttribute("aria-pressed") !== "true"; setFav(g, on); b.setAttribute("aria-pressed", String(on)); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); haptic(on ? 14 : 6); if (state.lib === "fav") ctx.renderLibrary(); renderHome(); };
    return b;
  }
  /** does a local game pass the search box, the Recenti / Preferiti tab and the Locale / Cloud filter? */
  function visible(g, { inCloud }) {
    if (state.q) { const q = state.q.toLowerCase(); if (!((g.title || "").toLowerCase().includes(q) || (g.code || g.serial || "").toLowerCase().includes(q))) return false; }
    if (state.lib === "recent" && !recent()[g.id]) return false;
    if (state.lib === "fav" && !isFav(g)) return false;
    if (state.loc === "cloud" && !inCloud) return false;
    if (state.loc === "local" && inCloud) return false;
    return true;
  }
  const visibleCloudOnly = (title) => (!state.q || String(title || "").toLowerCase().includes(state.q.toLowerCase())) && state.lib === "all" && state.loc !== "local";

  // ================================================================= navigation
  function syncNav(screen) {
    const s = screen || body.dataset.screen; let cur = "";
    if (s === "library") cur = tab === "settings" ? "profile" : tab; else if (s === "friends" || s === "party") cur = "friends"; else if (s === "profile" || s === "cloudlib") cur = "profile";
    document.querySelectorAll("#psNav [data-nav]").forEach((b) => { if (b.dataset.nav === cur) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    body.classList.toggle("has-nav", NAV_SCREENS.has(s));
  }
  function setPanel(t) {
    tab = TABS.includes(t) ? t : "home"; body.dataset.tab = tab;
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (tab === "home") renderHome(); if (tab === "multiplayer") renderMp(); if (tab === "settings") renderSettings();
  }
  /** show one of the four panels of the main screen */
  let going = false;
  function go(t, { push = false, replace = false } = {}) {
    tab = TABS.includes(t) ? t : "home"; going = true; try { ctx.show("library"); } finally { going = false; } setPanel(tab); syncNav("library");
    if (TABS.includes(t) && t !== "settings") LS.set("ps.route", t);
    const url = "#/" + tab; if (push && location.hash !== url) { try { history.pushState({ ps: 1 }, "", url); } catch { /* ok */ } } else if (replace) { try { history.replaceState({ ps: 1 }, "", url); } catch { /* ok */ } }
    scrollTo(0, 0);
  }
  function navTo(item) {
    haptic(8);
    if (item === "friends") { if (ctx.loggedIn()) { ctx.openFriends(); push("friends"); } else { ctx.openAccount("Accedi per vedere i tuoi amici."); } return; }
    if (item === "profile") { if (ctx.loggedIn()) { ctx.openProfile(); push("profile"); } else ctx.openAccount(); return; }
    go(item, { push: true });
  }
  const push = (name) => { const url = "#/" + name; if (location.hash !== url) { try { history.pushState({ ps: 1 }, "", url); } catch { /* ok */ } } };
  function applyRoute() {
    const m = /^#\/(home|games|multiplayer|settings|friends|profile)$/.exec(location.hash || ""); const r = m ? m[1] : null; if (!r) return false;
    if (r === "friends") { if (ctx.loggedIn()) ctx.openFriends(); else go("home"); } else if (r === "profile") { if (ctx.loggedIn()) ctx.openProfile(); else go("home"); } else go(r);
    return true;
  }
  /** Back (browser button, Android gesture) from a sub-screen does what its own BACK button does; it never traps the user */
  function onPop() {
    if (ctx.playing()) return;                          // a running game keeps its own "really leave?" guard
    const s = body.dataset.screen, btn = SUB_BACK[s];
    if (btn && $(btn)) { $(btn).click(); }
    applyRoute();
  }
  addEventListener("popstate", onPop);
  function onScreen(name) {
    syncNav(name);
    if (name === "library" && !going) setPanel(tab);       // coming back from a sub screen: the tab the user was on
    if (name === "profile") renderProfileExtras();
    body.classList.toggle("ps-lock", false);
  }

  // ================================================================= HOME
  function greet() {
    const u = ctx.cloud && ctx.cloud.state === "user" && ctx.cloud.user; const hr = new Date().getHours();
    $("homeHello").textContent = (hr < 6 ? "Buonanotte" : hr < 13 ? "Buongiorno" : hr < 19 ? "Buon pomeriggio" : "Buonasera") + (u ? ", " + u.displayName : "") + "!";
    $("homeSub").textContent = ctx.games().length ? "Cosa giochiamo oggi?" : "Aggiungi il tuo primo gioco per cominciare.";
  }
  function emptyCard({ icon, title, text, cta, onCta, id }) {
    const e = h("div", { class: "ps-empty", id }, h("span", { class: "ico" }), h("h3", { text: title }), h("p", { text }));
    e.querySelector(".ico").append(ICON(icon)); if (cta) e.append(h("button", { class: "cta primary", type: "button", text: cta, onclick: onCta })); return e;
  }
  function renderHero() {
    const box = $("homeHero"); box.innerHTML = ""; const games = ctx.games(), r = recent();
    const last = games.filter((g) => r[g.id]).sort((a, b) => r[b.id] - r[a.id])[0] || games[0];
    if (!last) { box.append(emptyCard({ icon: "gamepad", title: "La tua libreria è vuota", text: "Scegli un gioco dal tuo dispositivo: PlaySphere riconosce da solo il sistema.", cta: "AGGIUNGI UN GIOCO", onCta: () => { go("games", { push: true }); $("romFile").click(); }, id: "homeEmpty" })); return; }
    const hero = h("div", { class: "ps-hero", id: "homeContinue" }, cover(last.title, last.platform || "NDS"),
      h("div", { class: "body" }, h("span", { class: "kick", text: r[last.id] ? "Continua a giocare" : "Inizia da qui" }), h("span", { class: "ttl", text: last.title || last.id }),
        h("span", { class: "hint", text: platformName(last.platform || "NDS") + (r[last.id] ? " · " + ago(r[last.id]) : "") }),
        h("div", { class: "ps-btn-row" }, h("button", { class: "cta primary", id: "homePlay", type: "button", text: "GIOCA", onclick: () => { haptic(12); ctx.play(last.id); } }),
          h("button", { class: "mini", type: "button", text: "DETTAGLI", onclick: () => openDetail(last) }))));
    box.append(hero);
  }
  function miniCard(g) {
    const b = h("button", { class: "ps-mini-card", type: "button", "data-id": g.id, onclick: () => openDetail(g) }, cover(g.title, g.platform || "NDS"), h("b", { text: g.title || g.id }), h("small", { text: recent()[g.id] ? ago(recent()[g.id]) : platformName(g.platform || "NDS") }));
    return b;
  }
  function renderRecent() {
    const box = $("homeRecent"); box.innerHTML = ""; const games = ctx.games(), r = recent();
    const list = games.filter((g) => r[g.id]).sort((a, b) => r[b.id] - r[a.id]).slice(0, 10);
    if (!list.length) { box.append(h("p", { class: "hint", text: games.length ? "Appena giochi, i tuoi ultimi giochi compaiono qui." : "Nessun gioco ancora." })); return; }
    for (const g of list) box.append(miniCard(g));
  }
  function personRow(f, action) {
    return h("div", { class: "ps-row ps-card", style: "padding:12px 14px;flex-direction:row" }, h("span", { class: "ps-avatar sm", "data-status": f.status || "OFFLINE", text: ctx.avatarOf(f.avatar) }), h("span", { class: "nm grow" }, h("b", { text: f.displayName }), h("small", { text: ctx.statusText(f) })), action || "");
  }
  function renderFriendsHome() {
    const box = $("homeFriends"); box.innerHTML = "";
    if (!ctx.loggedIn()) { box.append(emptyCard({ icon: "friends", title: "Gioca con gli amici", text: "Accedi per vedere chi è online e invitarlo.", cta: "ACCEDI", onCta: () => ctx.openAccount() })); return; }
    const on = ctx.cloud.friends.filter((f) => f.status && f.status !== "OFFLINE").slice(0, 3);
    if (!on.length) { box.append(emptyCard({ icon: "friends", title: ctx.cloud.friends.length ? "Nessun amico online" : "Nessun amico ancora", text: ctx.cloud.friends.length ? "Quando un amico è online lo vedi qui." : "Cerca un nome utente per aggiungere il primo amico.", cta: ctx.cloud.friends.length ? null : "AGGIUNGI AMICI", onCta: () => ctx.openFriends() })); return; }
    for (const f of on) box.append(personRow(f, h("button", { class: "mini primary", type: "button", text: "INVITA", disabled: f.status === "IN_GAME", onclick: () => { haptic(10); ctx.invite(f); } })));
  }
  function renderPartyHome() {
    const box = $("homeParty"); box.innerHTML = ""; const s = ctx.session && ctx.session();
    if (s) box.append(h("div", { class: "ps-card", id: "homeRoom" }, h("div", { class: "ps-row" }, h("span", { class: "ps-avatar sm", text: "🎮" }), h("span", { class: "nm grow" }, h("b", { text: "Stanza attiva" }), h("small", { text: s.role === "host" ? "Sei l'host" : "Stai per giocare con un amico" })), h("button", { class: "mini primary", type: "button", text: "TORNA ALLA STANZA", onclick: () => ctx.show("lobby") }))));
    const p = ctx.party;
    if (p && p.inParty) {
      const members = [...p.members.values()];
      box.append(h("div", { class: "ps-card", id: "homePartyCard" }, h("div", { class: "ps-row" }, h("div", { class: "ps-row", style: "gap:0" }, ...members.slice(0, 4).map((m, i) => h("span", { class: "ps-avatar sm" + (m.speaking ? " speaking" : ""), style: i ? "margin-left:-10px" : "", text: ctx.avatarOf(m.avatar) }))), h("span", { class: "nm grow" }, h("b", { text: "Party attivo" }), h("small", { text: members.length + (members.length === 1 ? " persona" : " persone") })), h("button", { class: "mini primary", type: "button", text: "APRI", onclick: () => $("btnParty").click() }))));
    } else if (!s) {
      box.append(ctx.loggedIn() ? emptyCard({ icon: "mic", title: "Nessun party", text: "Parla con gli amici mentre giochi.", cta: "CREA PARTY", onCta: () => $("btnParty").click() }) : h("p", { class: "hint", text: "Nessuna stanza né party attivi. Accedi per creare un party vocale." }));
    }
  }
  function syncInfo() {
    if (!ctx.loggedIn()) return ["local", "Solo locale", "cloud"];
    if (!navigator.onLine || ctx.cloud.state === "offline") return ["offline", "Offline", "wifi-off"];
    if (ctx.cfiles && ctx.cfiles.storageOff) return ["local", "Cloud storage non configurato", "cloud"];
    if (ctx.cfiles && ctx.cfiles.conflicts && ctx.cfiles.conflicts.size) return ["conflict", "Conflitto da risolvere", "sync"];
    if (ctx.syncing()) return ["syncing", "Sincronizzazione…", "sync"];
    return ["synced", "Sincronizzato", "check"];
  }
  function renderSync() {
    const [st, txt, ico] = syncInfo(); const el = $("homeSync"); el.dataset.state = st; el.replaceChildren(ICON(ico), h("span", { text: txt }));
    el.setAttribute("aria-label", "Stato Cloud: " + txt);
  }
  function renderTip() {
    const sec = $("homeTipSec"), box = $("homeTip"); const games = ctx.games(); let tip = null;
    const ps1 = games.some((g) => g.platform === "PS1"), noBios = ctx.ps1BiosMissing();
    if (ps1 && noBios) tip = { ico: "💿", text: "Per i giochi PlayStation conviene aggiungere il BIOS: così funzionano meglio.", cta: "AGGIUNGI BIOS", fn: () => { go("settings", { push: true }); setTimeout(() => $("addPs1Bios").scrollIntoView({ block: "center" }), 60); } };
    else if (games.length && !ctx.loggedIn()) tip = { ico: "☁️", text: "Con un account i salvataggi ti seguono su ogni dispositivo.", cta: "ACCEDI", fn: () => ctx.openAccount() };
    else if (games.length && ctx.loggedIn() && !ctx.cloud.friends.length) tip = { ico: "👋", text: "Aggiungi un amico per giocare insieme.", cta: "AMICI", fn: () => ctx.openFriends() };
    sec.hidden = !tip; box.innerHTML = ""; if (tip) box.append(h("span", { class: "ico", text: tip.ico, "aria-hidden": "true" }), h("p", { text: tip.text }), h("button", { class: "mini primary", type: "button", text: tip.cta, onclick: tip.fn }));
  }
  function renderHome() { greet(); renderHero(); renderRecent(); renderFriendsHome(); renderPartyHome(); renderSync(); renderTip(); renderInstall(); }

  // ================================================================= LIBRARY extras
  function renderLocFilter() {
    const box = $("locFilter"); box.innerHTML = ""; const cl = ctx.cloudReady(); box.hidden = !cl; if (!cl) { state.loc = "all"; return; }
    for (const [id, txt] of [["all", "Tutti"], ["local", "Locale"], ["cloud", "Cloud"]]) box.append(h("button", { type: "button", class: "chip" + (state.loc === id ? " on" : ""), "data-loc": id, "aria-pressed": String(state.loc === id), text: txt, onclick: () => { state.loc = id; ctx.renderLibrary(); } }));
  }
  function libraryEmpty(total) {
    const ul = $("gameList"); if (ul.querySelector("li.game")) return;
    const searching = state.q || state.lib !== "all" || state.loc !== "all";
    ul.append(h("li", { class: "hint", style: "grid-column:1/-1" }, searching ? emptyCard({ icon: "search", title: "Nessun risultato", text: state.lib === "fav" ? "Tocca il cuore su un gioco per averlo qui." : state.lib === "recent" ? "Appena giochi, i giochi recenti compaiono qui." : "Prova con un altro nome o togli i filtri." }) : emptyCard({ icon: "gamepad", title: "La tua libreria è vuota", text: "Aggiungi un gioco dal tuo dispositivo con il pulsante qui sotto.", id: "libEmpty" })));
    void total;
  }
  function skeletons(n = 4) { const ul = $("gameList"); ul.innerHTML = ""; for (let i = 0; i < n; i++) ul.append(h("li", { class: "game skel", "aria-hidden": "true" })); }
  function bindLibrary() {
    $("gameSearch").oninput = () => { state.q = $("gameSearch").value.trim(); ctx.renderLibrary(); };
    document.querySelectorAll("#libTabs [data-lib]").forEach((b) => { b.onclick = () => { state.lib = b.dataset.lib; document.querySelectorAll("#libTabs [data-lib]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); haptic(6); ctx.renderLibrary(); }; });
  }

  // ================================================================= GAME DETAIL (bottom sheet)
  /** d: { game, title, platform, sub, size, state: "both"|"local"|"cloud", conflict, onPlay, onRemove, cloudActions:[{label, fn, cls}], onHistory, canMp, friendsPlaying:[names] } */
  function openDetail(g) {
    const d = ctx.detailOf(g); if (!d) return; detailFor = d; lastFocus = document.activeElement;
    const c = $("gdCover"); c.replaceWith(Object.assign(cover(d.title, d.platform, ""), { id: "gdCover" })); $("gdTitle").textContent = d.title;
    const facts = $("gdFacts"); facts.innerHTML = "";
    const fact = (k, v) => facts.append(h("li", {}, h("small", { text: k }), h("span", { text: v })));
    const lp = d.game && recent()[d.game.id]; fact("Sistema", platformName(d.platform)); fact("Ultimo utilizzo", lp ? ago(lp) : "Mai"); fact("Spazio", d.size ? ctx.fmtSize(d.size) : "—");
    fact("Salvataggi", d.saveText); fact("Dove si trova", d.state === "both" ? "Su questo dispositivo e nel Cloud" : d.state === "cloud" ? "Solo nel Cloud" : "Solo su questo dispositivo"); fact("Multiplayer", d.canMp ? "Sì, con gli amici" : "Gioco singolo");
    const fr = $("gdFriends"); fr.hidden = !d.friendsPlaying.length; fr.textContent = d.friendsPlaying.length ? "Ci stanno giocando: " + d.friendsPlaying.join(", ") : "";
    $("gdPlay").textContent = d.state === "cloud" ? "SCARICA E GIOCA" : "GIOCA"; $("gdPlay").onclick = () => { closeDetail(); haptic(12); d.onPlay(); };
    const fav = $("gdFav"); const showFav = !!d.game; fav.hidden = !showFav; if (showFav) { fav.setAttribute("aria-pressed", String(isFav(d.game))); fav.textContent = isFav(d.game) ? "♥ Preferito" : "♡ Preferito"; fav.onclick = () => { const on = fav.getAttribute("aria-pressed") !== "true"; setFav(d.game, on); fav.setAttribute("aria-pressed", String(on)); fav.textContent = on ? "♥ Preferito" : "♡ Preferito"; haptic(on ? 14 : 6); ctx.renderLibrary(); renderHome(); }; }
    const panel = $("gdPanel"); panel.hidden = true; panel.innerHTML = "";
    $("gdFiles").onclick = () => { panel.innerHTML = ""; panel.hidden = false; panel.append(h("p", { class: "hint", text: "Gestisci i file di questo gioco" })); const acts = h("div", { class: "acts" }); for (const a of d.fileActions) acts.append(h("button", { class: a.cls || "mini", type: "button", text: a.label, onclick: () => { closeDetail(); a.fn(); } })); if (!d.fileActions.length) acts.append(h("p", { class: "hint", text: "Nessuna azione disponibile." })); panel.append(acts); };
    $("gdSave").hidden = !d.onHistory; $("gdInfo").style.gridColumn = d.onHistory ? "" : "1 / -1"; $("gdSave").onclick = () => { closeDetail(); d.onHistory(); };
    $("gdInfo").onclick = () => { panel.innerHTML = ""; panel.hidden = false; panel.append(h("p", { class: "hint", text: [d.sub, d.size ? ctx.fmtSize(d.size) : "", d.discs > 1 ? d.discs + " dischi" : ""].filter(Boolean).join(" · ") }), h("p", { class: "hint", text: "I file del gioco non lasciano mai questo dispositivo, se non vai tu a metterli nel tuo Cloud." })); };
    $("gdClose").onclick = closeDetail; const ov = $("gameDetail"); ov.hidden = false; body.classList.add("ps-lock"); $("gdPlay").focus({ preventScroll: true });
    ov.onclick = (e) => { if (e.target === ov) closeDetail(); };
  }
  function closeDetail() { $("gameDetail").hidden = true; body.classList.remove("ps-lock"); detailFor = null; if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch { /* gone */ } } }
  addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("gameDetail").hidden) closeDetail(); else if (!$("aboutBox").hidden) $("aboutBox").hidden = true; } });

  // ================================================================= MULTIPLAYER panel
  function setSeg(v) { mpSeg = v; LS.set("ps.mp", v); document.querySelectorAll("#mpSeg [data-mp]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mp === v))); document.querySelectorAll("[data-mp-pane]").forEach((p) => { p.hidden = p.dataset.mpPane !== v; }); if (v === "online") renderMpOnline(); }
  function renderMp() { setSeg(mpSeg); const s = ctx.session && ctx.session(), box = $("mpRoomNow"); box.innerHTML = ""; if (s) box.append(h("button", { class: "cta primary", type: "button", text: "TORNA ALLA STANZA", onclick: () => ctx.show("lobby") })); }
  function renderMpOnline() {
    const box = $("mpOnline"); box.innerHTML = "";
    if (!ctx.loggedIn()) { box.append(emptyCard({ icon: "globe", title: "Gioca online", text: "Accedi per invitare gli amici anche se non sono vicino a te.", cta: "ACCEDI", onCta: () => ctx.openAccount("Accedi per giocare online."), id: "mpGate" })); return; }
    box.append(h("div", { class: "ps-h" }, h("h2", { text: "Amici online" }), h("button", { type: "button", text: "Vedi tutti", onclick: () => ctx.openFriends() })));
    const on = ctx.cloud.friends.filter((f) => f.status && f.status !== "OFFLINE"), list = h("div", { class: "ps-list", id: "mpFriends" });
    if (!on.length) list.append(emptyCard({ icon: "friends", title: "Nessun amico online", text: "Quando un amico è online puoi invitarlo qui." })); for (const f of on) list.append(personRow(f, h("button", { class: "mini primary", type: "button", text: "INVITA", disabled: f.status === "IN_GAME", onclick: () => { haptic(10); ctx.invite(f); } })));
    box.append(list, h("button", { class: "cta", type: "button", style: "margin-top:12px", onclick: () => $("btnParty").click() }, ICON("mic"), " Party vocale"));
  }
  function bindMp() { document.querySelectorAll("#mpSeg [data-mp]").forEach((b) => { b.onclick = () => { setSeg(b.dataset.mp); haptic(6); }; }); }

  // ================================================================= SETTINGS, ABOUT, dev mode
  let version = { version: "dev", build: "dev", commit: "", date: "" };
  async function loadVersion() { for (const f of ["version.json", "build.json"]) { try { const r = await fetch(new URL("./" + f, import.meta.url), { cache: "no-store" }); if (r.ok) version = { ...version, ...(await r.json()) }; } catch { /* offline or dev tree */ } } renderVersion(); }
  function renderVersion() {
    const s = `PlaySphere ${version.version}${version.commit ? " · " + String(version.commit).slice(0, 7) : ""}`; $("verLine").textContent = s; $("abVersion").textContent = s + (version.build && version.build !== "dev" ? " · build " + String(version.build).slice(0, 8) : "");
  }
  function renderSettings() {
    const off = ctx.cfiles && ctx.cfiles.storageOff, co = $("cloudOff");
    co.hidden = ctx.loggedIn() && !off; co.textContent = off && ctx.loggedIn() ? "Cloud storage non configurato. Giochi, file di sistema e salvataggi restano su questo dispositivo; account, amici e multiplayer funzionano." : "Accedi per sincronizzare giochi, file di sistema e salvataggi nel tuo Cloud privato.";
    ctx.updateUsage && ctx.updateUsage(); }
  function bindSettings() {
    $("btnSettings").onclick = () => { go("settings", { push: true }); };
    $("btnAbout").onclick = () => { $("aboutBox").hidden = false; body.classList.add("ps-lock"); $("abClose").focus(); };
    $("abClose").onclick = () => { $("aboutBox").hidden = true; body.classList.remove("ps-lock"); };
    // developer mode: tap the version seven times (or open the page with ?dev=1); it shows the diagnostic settings and the on-screen statistics
    let taps = 0, tt = 0; $("verLine").onclick = () => { clearTimeout(tt); tt = setTimeout(() => { taps = 0; }, 1500); if (++taps >= 7) { taps = 0; const on = !ctx.dev(); ctx.setDev(on); toast(on ? "Modalità sviluppatore attiva" : "Modalità sviluppatore disattivata"); } };
    $("btnProfSettings").onclick = () => go("settings", { push: true });
  }

  // ================================================================= PROFILE extras
  function renderProfileExtras() {
    const games = ctx.games(), r = recent(); $("statGames").textContent = String(games.length); $("statFriends").textContent = String(ctx.cloud ? ctx.cloud.friends.length : 0); $("statRecent").textContent = String(games.filter((g) => r[g.id]).length);
    const box = $("profRecent"); box.innerHTML = ""; const list = games.filter((g) => r[g.id]).sort((a, b) => r[b.id] - r[a.id]).slice(0, 8);
    if (!list.length) box.append(h("p", { class: "hint", text: "Nessun gioco recente." })); for (const g of list) box.append(miniCard(g));
  }

  // ================================================================= toasts
  let toastT = 0;
  function toast(msg, kind = "") {
    const t = $("cloudToast"); t.textContent = ""; if (kind) t.append(h("span", { class: "ico", "aria-hidden": "true", text: kind === "ok" ? "✓" : kind === "err" ? "!" : "" })); t.append(String(msg));
    t.className = "assist " + kind; t.hidden = false; t.setAttribute("role", kind === "err" ? "alert" : "status"); clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500);
    if (kind === "ok") haptic(12); else if (kind === "err") haptic([20, 40, 20]);
  }

  // ================================================================= errors and loading
  function showError(msg, { alt } = {}) {
    const e = explain(msg);
    $("errorTitle").textContent = e.title; $("errorNote").textContent = e.what; $("errorTodo").textContent = e.todo;
    const first = String(msg || "").split("\n")[0].slice(0, 160), tech = $("errorTechBox"); tech.hidden = !first || e === GENERIC && !first; $("errorTech").textContent = first;
    const b = $("btnErrAlt"); b.hidden = !alt; if (alt) { b.textContent = alt.label; b.onclick = alt.fn; }
    $("btnErrBack").textContent = "TORNA ALLA LIBRERIA"; ctx.show("error"); haptic([20, 40, 20]);
  }
  function loading(title, note, step) {
    $("loadingTitle").textContent = title ? title : "Avvio"; $("loadingNote").textContent = note || "";
    const order = ["files", "core", "ready"], i = order.indexOf(step);
    document.querySelectorAll("#loadingSteps li").forEach((li) => { const k = order.indexOf(li.dataset.step); li.className = i < 0 ? "" : k < i ? "done" : k === i ? "on" : ""; });
  }

  // ================================================================= first run
  const WS = () => document.querySelectorAll("#wSlides .ps-slide");
  function shouldWelcome() { const p = new URLSearchParams(location.search); if (p.get("welcome") === "1") return true; if (p.get("welcome") === "0" || LS.get("ps.welcomed") === "1") return false; return !navigator.webdriver; }
  function showWelcome() {
    const dots = $("wDots"); dots.innerHTML = ""; WS().forEach(() => dots.append(h("i"))); welcomeIdx = 0; paintWelcome(); $("psWelcome").hidden = false; $("wNext").focus({ preventScroll: true });
  }
  function paintWelcome() { const s = WS(); s.forEach((el, i) => { el.classList.toggle("on", i === welcomeIdx); el.classList.toggle("prev", i < welcomeIdx); el.setAttribute("aria-hidden", String(i !== welcomeIdx)); }); [...$("wDots").children].forEach((d, i) => d.classList.toggle("on", i === welcomeIdx)); $("wNext").textContent = welcomeIdx === s.length - 1 ? "INIZIA" : "AVANTI"; $("wSkip").hidden = welcomeIdx === s.length - 1; }
  function endWelcome() { LS.set("ps.welcomed", "1"); $("psWelcome").hidden = true; go("home", { replace: true }); haptic(12); }
  function bindWelcome() { $("wNext").onclick = () => { if (welcomeIdx >= WS().length - 1) endWelcome(); else { welcomeIdx++; paintWelcome(); haptic(6); } }; $("wSkip").onclick = endWelcome; }

  // ================================================================= install, offline, update
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function renderInstall() {
    const c = $("installCard"); const dismissed = Date.now() - Number(LS.get("ps.installNo", "0")) < 14 * 86400e3;
    const can = !standalone() && !dismissed && (!!deferredInstall || (isIos() && /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)));
    c.hidden = !can; if (!can) return;
    $("installText").textContent = deferredInstall ? "Installa PlaySphere per aprirlo a schermo intero, anche offline." : "Su iPhone: tocca Condividi, poi «Aggiungi alla schermata Home».";
    $("btnInstall").hidden = !deferredInstall;
  }
  function bindInstall() {
    addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; renderInstall(); });
    addEventListener("appinstalled", () => { deferredInstall = null; $("installCard").hidden = true; toast("PlaySphere è installato", "ok"); });
    $("btnInstall").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch { /* ignored */ } deferredInstall = null; renderInstall(); };
    $("btnInstallLater").onclick = () => { LS.set("ps.installNo", String(Date.now())); $("installCard").hidden = true; };
  }
  function bindNet() {
    const sync = () => { $("psOffline").hidden = navigator.onLine; renderSync(); };
    addEventListener("online", () => { sync(); toast("Di nuovo online", "ok"); }); addEventListener("offline", () => { sync(); toast("Sei offline: i giochi su questo dispositivo funzionano comunque"); }); sync();
  }
  function bindViewport() {
    const vv = window.visualViewport; if (!vv) return;
    const f = () => { const kb = innerHeight - vv.height > 150; body.classList.toggle("kb-open", kb); }; vv.addEventListener("resize", f); f();
  }
  function bindNav() {
    document.querySelectorAll("#psNav [data-nav]").forEach((b) => { b.onclick = () => navTo(b.dataset.nav); });
    document.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => navTo(b.dataset.go); });
    $("btnCopyCode").onclick = async () => { const code = $("codeText").textContent; try { await navigator.clipboard.writeText(code); } catch { const r = document.createRange(); r.selectNodeContents($("codeText")); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); try { document.execCommand("copy"); } catch { /* manual */ } sl.removeAllRanges(); }
      const b = $("btnCopyCode"); b.classList.add("done"); toast("Codice copiato", "ok"); setTimeout(() => b.classList.remove("done"), 1200); };
  }

  // ================================================================= start
  function start() {
    initPrefs(); bindNav(); bindLibrary(); bindMp(); bindSettings(); bindWelcome(); bindInstall(); bindNet(); bindViewport(); loadVersion();
    // a library message that is an error (not the "Aggiungo il gioco…" progress) is also shown as a toast: the line itself sits at the bottom of the page
    new MutationObserver(() => { const t = $("libErr").textContent; if (t && !/…$/.test(t)) toast(t, "err"); }).observe($("libErr"), { childList: true, characterData: true, subtree: true });
    $("btnUpdateLater").onclick = () => { $("updateBar").hidden = true; ctx.updateLater(); };
    const m = /^#\/(home|games|multiplayer|settings)$/.exec(location.hash || ""); const saved = LS.get("ps.route", "home");
    const first = m ? m[1] : TABS.includes(saved) ? saved : "home";
    go(first, { replace: true }); if (shouldWelcome()) showWelcome();
  }

  // everything that depends on live data (friends, party, Cloud state) re-renders through this: coalesced, and only for what is on screen
  let rT = 0;
  function refresh() {
    if (rT) return; rT = setTimeout(() => {
      rT = 0; const s = body.dataset.screen;
      if (s === "library") { if (tab === "home") renderHome(); else if (tab === "multiplayer") { renderMp(); } else if (tab === "settings") renderSettings(); }
      else if (s === "profile") renderProfileExtras();
    }, 60);
  }

  return {
    refresh, start, go, onScreen, haptic, toast, played, cover, favButton, visible, visibleCloudOnly, renderLocFilter, libraryEmpty, skeletons, openDetail, closeDetail, renderHome, renderSync, renderProfileExtras, renderMp, showError, loading, explain,
    get tab() { return tab; }, get state() { return state; }, renderMpOnline: () => { if (tab === "multiplayer" && mpSeg === "online") renderMpOnline(); },
  };
}
