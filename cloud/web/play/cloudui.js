// Account / profile / friends / invites screens. Minimal and functional (the final design is a later phase). All of it is OPTIONAL: the library and GIOCA never wait for it.
const AVATARS = ["🎮", "🕹️", "👾", "🐱", "🐶", "🦊", "🐼", "🐸", "🚀", "⭐", "🍄", "🔥"];
export const avatarOf = (a) => AVATARS[Math.max(0, Math.min(AVATARS.length - 1, parseInt(String(a || "a0").slice(1), 10) || 0))];
const STATUS = { OFFLINE: "Offline", ONLINE: "Online", MENU: "Nel menu", IN_GAME: "In gioco" };
export const statusText = (f) => (f.status === "IN_GAME" && f.game && f.game.title ? "In gioco · " + f.game.title : STATUS[f.status] || "Offline");
const ERR = { username_taken: "Questo nome utente esiste già.", invalid_username: "Nome utente: 3-20 caratteri a-z 0-9 _", invalid_password: "La password deve avere almeno 10 caratteri.", invalid_credentials: "Nome utente o password errati.",
  too_many_attempts: "Troppi tentativi. Riprova tra qualche minuto.", cancelled: "Operazione annullata.", passkey_failed: "La passkey non ha funzionato su questo dispositivo.", passkeys_unsupported: "Le passkey non sono disponibili qui: usa la password.",
  network: "Cloud non raggiungibile. Il gioco in locale funziona comunque.", user_not_found: "Utente non trovato.", already_friends: "Siete già amici.", request_already_pending: "Richiesta già inviata.", user_blocked: "Hai bloccato questo utente.",
  friend_offline: "L'amico non è online.", friend_busy: "L'amico sta già giocando.", not_friends: "Non siete amici.", invite_expired: "L'invito è scaduto.", invite_not_pending: "Invito non più valido.", room_gone: "La stanza non esiste più.", game_not_found: "Gioco non nella tua libreria." };
export const errText = (r) => ERR[r && r.error] || (r && r.error ? "Errore: " + r.error : "Errore");

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k.startsWith("on")) e[k] = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v); }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export function initCloudUI(ctx) {
  const { $, show, cloud } = ctx;
  const toast = (msg) => { const t = $("cloudToast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500); };
  let back = "library";
  const go = (name) => { back = document.body.dataset.screen === name ? back : document.body.dataset.screen; show(name); };

  // ---- account chip in the library header
  const chip = () => {
    const b = $("btnAccount"); if (!b) return;
    if (cloud.state === "user" && cloud.user) { b.textContent = `${avatarOf(cloud.user.avatar)} @${cloud.user.username}`; b.dataset.mode = "user"; }
    else if (cloud.state === "offline") { b.textContent = "☁ Cloud non raggiungibile"; b.dataset.mode = "offline"; }
    else { b.textContent = "ACCEDI"; b.dataset.mode = "anon"; }
    const n = (cloud.invites.incoming || []).length + (cloud.requests.incoming || []).length;
    b.dataset.badge = n ? String(n) : "";
  };
  $("btnAccount").onclick = () => { if (cloud.state === "user") { renderProfile(); go("profile"); } else { renderAuth(); go("account"); } };

  // ---- sign in / create account
  const authErr = (m) => { $("authErr").textContent = m || ""; };
  function renderAuth() {
    authErr(""); $("authPasskeyNote").hidden = ctx.passkeys();
  }
  const fields = () => ({ username: $("authUser").value.trim().toLowerCase(), display: $("authDisplay").value.trim(), password: $("authPass").value });
  $("btnAuthBack").onclick = () => show("library");
  $("btnPkCreate").onclick = async () => { const f = fields(); authErr(""); const r = await cloud.registerPasskey(f.username, f.display); if (r.ok) done(); else authErr(errText(r)); };
  $("btnPkLogin").onclick = async () => { authErr(""); const r = await cloud.loginPasskey(); if (r.ok) done(); else authErr(errText(r)); };
  $("btnPwCreate").onclick = async () => { const f = fields(); authErr(""); const r = await cloud.registerPassword(f.username, f.password, f.display); if (r.ok) done(); else authErr(errText(r)); };
  $("btnPwLogin").onclick = async () => { const f = fields(); authErr(""); const r = await cloud.loginPassword(f.username, f.password); if (r.ok) done(); else authErr(errText(r)); };
  function done() { $("authPass").value = ""; chip(); ctx.syncLibrary(); renderProfile(); show("profile"); }

  // ---- profile
  async function renderProfile() {
    const u = cloud.user; if (!u) return;
    $("profAvatar").textContent = avatarOf(u.avatar); $("profName").textContent = u.displayName; $("profUser").textContent = "@" + u.username;
    $("profStatus").textContent = cloud.presence === "OFFLINE" ? "Connessione in corso…" : (STATUS[cloud.presence] || cloud.presence);
    $("profEdit").hidden = true; $("profSessions").hidden = true;
  }
  $("btnProfBack").onclick = () => show("library");
  $("btnProfEdit").onclick = () => {
    const u = cloud.user; $("editName").value = u.displayName; const sel = $("editAvatar"); sel.innerHTML = "";
    AVATARS.forEach((a, i) => sel.append(h("option", { value: "a" + i, text: a, selected: u.avatar === "a" + i })));
    $("profEdit").hidden = false;
  };
  $("btnEditSave").onclick = async () => { const r = await cloud.updateProfile({ displayName: $("editName").value.trim(), avatar: $("editAvatar").value }); if (r.ok) { renderProfile(); chip(); } else toast(errText(r)); };
  $("btnProfFriends").onclick = async () => { await renderFriends(); go("friends"); };
  $("btnProfLibrary").onclick = () => { renderCloudLib(); go("cloudlib"); };
  $("btnProfLogout").onclick = async () => { await cloud.logout(); chip(); show("library"); };
  $("btnProfSessions").onclick = async () => {
    const r = await cloud.sessions(); const box = $("profSessions"); box.hidden = false; box.innerHTML = "";
    if (!r.ok) { box.append(h("p", { class: "hint", text: errText(r) })); return; }
    for (const s of r.body.sessions) box.append(h("div", { class: "row2" }, h("span", { text: (s.device || "dispositivo").replace(/\(.*?\)/g, "").slice(0, 40) + (s.current ? " (questo)" : "") }),
      s.current ? "" : h("button", { class: "mini danger", text: "REVOCA", onclick: async () => { await cloud.revokeSession(s.id); $("btnProfSessions").onclick(); } })));
    box.append(h("button", { class: "mini", text: "ESCI DAGLI ALTRI DISPOSITIVI", onclick: async () => { await cloud.revokeOthers(); $("btnProfSessions").onclick(); } }));
  };

  // ---- friends
  const badge = (f) => h("span", { class: "pres " + (f.status || "OFFLINE").toLowerCase(), text: statusText(f) });
  const who = (u, extra) => h("div", { class: "who" }, h("span", { class: "av", text: avatarOf(u.avatar) }), h("span", { class: "nm" }, h("b", { text: u.displayName }), h("small", { text: "@" + u.username })), extra || "");
  async function renderFriends() {
    await Promise.all([cloud.loadFriends(), cloud.loadRequests(), cloud.loadBlocked()]);
    const act = async (fn, okMsg) => { const r = await fn(); if (!r.ok) toast(errText(r)); else if (okMsg) toast(okMsg); await renderFriends(); };
    const L = $("friendList"); L.innerHTML = "";
    if (!cloud.friends.length) L.append(h("li", { class: "hint", text: "Nessun amico ancora. Cerca un nome utente qui sopra." }));
    for (const f of cloud.friends) L.append(h("li", {}, who(f, badge(f)),
      h("div", { class: "acts" }, h("button", { class: "mini primary", text: "INVITA A GIOCARE", disabled: f.status === "OFFLINE" || f.status === "IN_GAME", onclick: () => pickGame(f) }),
        h("button", { class: "mini", text: "RIMUOVI", onclick: () => act(() => cloud.removeFriend(f.userId)) }), h("button", { class: "mini danger", text: "BLOCCA", onclick: () => act(() => cloud.block(f.username)) }))));
    const R = $("reqList"); R.innerHTML = "";
    for (const q of cloud.requests.incoming) R.append(h("li", {}, who(q.user), h("div", { class: "acts" }, h("button", { class: "mini primary", text: "ACCETTA", onclick: () => act(() => cloud.acceptRequest(q.id)) }), h("button", { class: "mini", text: "RIFIUTA", onclick: () => act(() => cloud.refuseRequest(q.id)) }))));
    for (const q of cloud.requests.outgoing) R.append(h("li", {}, who(q.user, h("small", { text: "in attesa" })), h("div", { class: "acts" }, h("button", { class: "mini", text: "ANNULLA", onclick: () => act(() => cloud.cancelRequest(q.id)) }))));
    $("reqHead").hidden = !R.children.length;
    const B = $("blockList"); B.innerHTML = "";
    for (const u of cloud.blocked) B.append(h("li", {}, who(u), h("div", { class: "acts" }, h("button", { class: "mini", text: "SBLOCCA", onclick: () => act(() => cloud.unblock(u.userId)) }))));
    $("blockHead").hidden = !B.children.length;
    chip();
  }
  cloud.on((ev) => { if (["data", "presence"].includes(ev) && document.body.dataset.screen === "friends") renderFriends(); if (ev === "self" && document.body.dataset.screen === "profile") renderProfile(); chip(); });
  $("btnFriendsBack").onclick = () => { renderProfile(); show("profile"); };
  let searchT = 0;
  $("friendSearch").oninput = () => {
    clearTimeout(searchT); const q = $("friendSearch").value.trim(); const box = $("searchList"); if (q.length < 2) { box.innerHTML = ""; return; }
    searchT = setTimeout(async () => {
      const r = await cloud.search(q); box.innerHTML = ""; if (!r.ok) { box.append(h("li", { class: "hint", text: errText(r) })); return; }
      if (!r.body.users.length) box.append(h("li", { class: "hint", text: "Nessun utente trovato." }));
      for (const u of r.body.users) {
        const label = { NONE: "AGGIUNGI", OUTGOING: "Richiesta inviata", INCOMING: "Ti ha scritto: accetta sotto", FRIEND: "Già amici", BLOCKED: "Bloccato" }[u.relation];
        box.append(h("li", {}, who(u), u.relation === "NONE" ? h("button", { class: "mini primary", text: label, onclick: async () => { const x = await cloud.sendRequest(u.username); toast(x.ok ? (x.body.status === "accepted" ? "Ora siete amici" : "Richiesta inviata") : errText(x)); $("friendSearch").oninput(); renderFriends(); } }) : h("small", { text: label })));
      }
    }, 250);
  };

  // ---- cloud library (metadata): which games the account has; the file is on a device or it is not
  function renderCloudLib() {
    const L = $("cloudLibList"); L.innerHTML = ""; const local = ctx.localByGameId();
    if (!cloud.library.length) L.append(h("li", { class: "hint", text: "La libreria Cloud è vuota. Aggiungi un gioco da questo dispositivo." }));
    for (const e of cloud.library) {
      const g = local.get(e.gameId);
      L.append(h("li", {}, h("span", { class: "t" }, e.title, h("small", { text: `${e.platform.toUpperCase()}${e.productCode ? " · " + e.productCode : ""}${e.favorite ? " · ★" : ""}` })),
        g ? h("button", { class: "mini primary", text: "GIOCA", onclick: () => ctx.playLocal(g.id) }) : h("small", { class: "bad", text: "File di gioco non presente" })));
    }
  }
  $("btnCloudLibBack").onclick = () => { renderProfile(); show("profile"); };

  // ---- invite: pick one of MY games (cloud library entries whose file is on this device), then the room opens and the friend is told
  async function pickGame(friend) {
    const local = ctx.localByGameId(), mine = cloud.library.filter((e) => local.has(e.gameId));
    if (!mine.length) { toast("Aggiungi prima un gioco a questo dispositivo."); return; }
    const box = $("pickList"); box.innerHTML = ""; $("pickWho").textContent = friend.displayName;
    for (const e of mine) box.append(h("li", {}, h("span", { class: "t", text: e.title }), h("button", { class: "mini primary", text: "INVITA", onclick: async () => {
      $("pickGame").hidden = true;
      const r = await cloud.invite(friend.userId, e.gameId);
      if (!r.ok) { toast(errText(r)); return; }
      ctx.startInvite({ role: "host", code: r.body.room.code, token: r.body.room.token, gameId: e.gameId, inviteId: r.body.id });
    } })));
    $("pickGame").hidden = false;
  }
  $("btnPickCancel").onclick = () => { $("pickGame").hidden = true; };

  // ---- incoming invite (real time): ACCETTA / RIFIUTA, accepting enters the room with no code
  let current = null;
  function showInvite(inv) {
    current = inv; $("invWho").textContent = `${inv.from.displayName} ti invita a giocare a ${inv.game.title}`; $("inviteBox").hidden = false;
    clearTimeout(showInvite.t); showInvite.t = setTimeout(() => { if (current && current.id === inv.id) { $("inviteBox").hidden = true; current = null; } }, Math.max(1000, inv.expiresAt - Date.now()));
  }
  cloud.on((ev) => { if (ev === "data") { const first = cloud.invites.incoming[0]; if (first && (!current || current.id !== first.id)) showInvite({ id: first.id, from: first.other, game: first.game, expiresAt: first.expiresAt }); if (!first) { $("inviteBox").hidden = true; current = null; } } });
  $("btnInvAccept").onclick = async () => {
    if (!current) return; const inv = current; $("inviteBox").hidden = true; current = null;
    const r = await cloud.respondInvite(inv.id, true);
    if (!r.ok) { toast(errText(r)); return; }
    ctx.startInvite({ role: "guest", code: r.body.room.code, token: r.body.room.token, gameId: r.body.gameId, inviteId: inv.id });
  };
  $("btnInvRefuse").onclick = async () => { if (!current) return; const inv = current; $("inviteBox").hidden = true; current = null; await cloud.respondInvite(inv.id, false); };

  chip();
  return { chip, toast, renderProfile };
}
