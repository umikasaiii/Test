// Party Voice screens (functional; the final design is a later phase): the party panel, the floating microphone bar (also over a running game), invites in/out.
// Nothing here depends on the emulator: the party is created, joined and left from any screen, and survives a game start and a game exit.
import { avatarOf } from "./cloudui.js";

const ERR = { already_in_party: "Sei già in un party.", not_friends: "Puoi invitare solo i tuoi amici.", friend_offline: "L'amico non è online.", friend_in_party: "L'amico è già in un party.", invite_already_pending: "Invito già inviato.",
  party_full: "Il party è al completo.", user_blocked: "Non puoi invitare questo utente.", invite_expired: "L'invito è scaduto.", invite_not_pending: "Invito non più valido.", rate_limited: "Troppe richieste. Riprova tra poco.", network: "Cloud non raggiungibile.", owner_only: "Solo il proprietario può farlo.", party_gone: "Il party non esiste più.", not_in_party: "Non sei in un party." };
const errText = (r) => ERR[r && r.error] || (r && r.error ? "Errore: " + r.error : "Errore");
const CONN = { connecting: "connessione…", disconnected: "riconnessione…", failed: "riconnessione…", left: "non connesso", self: "" };

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k.startsWith("on")) e[k] = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v); }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export function initPartyUI(ctx) {
  const { $, show, cloud, party, toast } = ctx; let back = "library", pickOpen = false, incoming = null;

  function render() {
    const inP = party.inParty, logged = cloud.state === "user";
    $("btnParty").hidden = !logged; $("btnParty").textContent = inP ? `🎙 PARTY (${party.members.size})` : "🎙 PARTY"; $("btnParty").dataset.in = inP ? "1" : "0";
    const bar = $("partyBar"); bar.hidden = !inP;
    if (inP) {
      const micOn = party.micState === "on" && !party.muted; bar.dataset.speaking = party.localSpeaking ? "1" : "0"; bar.dataset.muted = party.muted ? "1" : "0";
      $("btnBarMic").textContent = party.micState !== "on" ? "🎙?" : party.muted ? "🔇" : "🎙"; $("btnBarMic").setAttribute("aria-label", micOn ? "Muta" : "Attiva microfono"); $("barCount").textContent = String(party.members.size);
      $("barSpeaker").hidden = ![...party.members.values()].some((m) => m.speaking && m.userId !== party.me);
    }
    if (document.body.dataset.screen === "party") renderPanel();
  }
  function renderPanel() {
    const inP = party.inParty; $("partyEmpty").hidden = inP; $("partyBody").hidden = !inP;
    if (!inP) { $("partyNote").textContent = ""; return; }
    const L = $("partyList"); L.innerHTML = "";
    for (const m of party.members.values()) {
      const me = m.userId === party.me, speaking = !!m.speaking, muted = me ? party.muted || party.micState !== "on" : m.muted;
      const li = h("li", { class: "pm" + (speaking ? " speaking" : ""), "data-user": m.userId, "data-speaking": speaking ? "1" : "0", "data-muted": muted ? "1" : "0", "data-conn": me ? "self" : m.conn || "" },
        h("div", { class: "who" }, h("span", { class: "av", text: avatarOf(m.avatar) }), h("span", { class: "nm" }, h("b", { text: m.displayName + (me ? " (tu)" : "") + (m.role === "owner" ? " 👑" : "") }), h("small", { text: "@" + m.username }))),
        h("span", { class: "mic", text: speaking ? "🗣" : muted ? "🔇" : "🎙" }), h("small", { class: "cn", text: me ? "" : CONN[m.conn] || (m.connected === false ? "non connesso" : "") }));
      if (!me) {
        const vol = h("input", { type: "range", min: "0", max: "150", value: String(Math.round((m.volume ?? 1) * 100)), "aria-label": "Volume di " + m.displayName, class: "vol" });
        vol.oninput = () => party.setVolume(m.userId, vol.value / 100); li.append(vol);
        if (party.amOwner) li.append(h("button", { class: "mini danger", text: "RIMUOVI", onclick: async () => { const r = await party.kick(m.userId); if (!r.ok) toast(errText(r)); else party.refresh(); } }));
      }
      L.append(li);
    }
    const micState = party.micState;
    $("btnPartyMute").textContent = micState === "on" ? (party.muted ? "UNMUTE" : "MUTE") : micState === "denied" || micState === "unavailable" ? "RIPROVA MICROFONO" : "ATTIVA MICROFONO";
    $("btnPartyDeaf").textContent = party.partyAudio ? "DISATTIVA AUDIO PARTY" : "ATTIVA AUDIO PARTY";
    $("partyNote").textContent = micState === "denied" ? "Microfono non consentito: ascolti il party ma non puoi parlare. Consenti il microfono nelle impostazioni del browser e riprova." : micState === "unavailable" ? "Nessun microfono disponibile: ascolti il party ma non puoi parlare." : party.state === "reconnecting" ? "Riconnessione al party…" : "";
    $("partyOwnerNote").hidden = !party.amOwner; $("partyPick").hidden = !pickOpen; if (pickOpen) renderPick();
  }
  function renderPick() {
    const L = $("partyPickList"); L.innerHTML = ""; const members = new Set([...party.members.keys()]);
    const cands = cloud.friends.filter((f) => !members.has(f.userId));
    if (!cands.length) L.append(h("li", { class: "hint", text: "Nessun amico da invitare." }));
    for (const f of cands) L.append(h("li", {}, h("div", { class: "who" }, h("span", { class: "av", text: avatarOf(f.avatar) }), h("span", { class: "nm" }, h("b", { text: f.displayName }), h("small", { text: f.status === "OFFLINE" ? "Offline" : f.party ? "Nel party" : "Online" }))),
      h("button", { class: "mini primary", text: "INVITA", disabled: f.status === "OFFLINE" || !!f.party, onclick: () => invite(f) })));
  }
  async function invite(f) {
    if (!party.inParty) { const c = await party.create(); if (!c.ok) { toast(errText(c)); return; } }
    const r = await party.invite(f.userId); toast(r.ok ? `Invito inviato a ${f.displayName}` : errText(r)); render();
  }
  function go(name) { back = document.body.dataset.screen === name ? back : document.body.dataset.screen; show(name); }
  async function open() { if (cloud.state !== "user") return; await cloud.loadFriends(); await party.restore().catch(() => {}); go("party"); render(); }

  $("btnParty").onclick = open;
  $("btnPartyBack").onclick = () => show(back === "party" ? "library" : back);
  $("btnPartyCreate").onclick = async () => { const r = await party.create(); if (!r.ok) toast(errText(r)); render(); };
  $("btnPartyLeave").onclick = async () => { await party.leave(); pickOpen = false; render(); };
  $("btnPartyMute").onclick = () => { if (party.micState === "on") party.setMuted(!party.muted); else party.enableMic(); };
  $("btnBarMic").onclick = () => party.toggleMute();
  $("btnBarOpen").onclick = open;
  $("btnPartyDeaf").onclick = () => party.setPartyAudio(!party.partyAudio);
  $("btnPartyInvite").onclick = async () => { pickOpen = !pickOpen; if (pickOpen) await cloud.loadFriends(); render(); };
  const duckOn = () => { try { return localStorage.getItem("dslink.duck") === "1"; } catch { return false; } };
  $("optDuck").checked = duckOn(); party.setDuck(duckOn());
  $("optDuck").onchange = () => { try { localStorage.setItem("dslink.duck", $("optDuck").checked ? "1" : "0"); } catch { /* none */ } party.setDuck($("optDuck").checked); };

  // ---- invites: realtime "X ti invita al Party" with ACCETTA / RIFIUTA
  function showInvite(inv) {
    incoming = inv; $("pInvWho").textContent = `${inv.from.displayName} ti invita al Party`; $("partyInviteBox").hidden = false;
    clearTimeout(showInvite.t); showInvite.t = setTimeout(() => { if (incoming && incoming.id === inv.id) { $("partyInviteBox").hidden = true; incoming = null; } }, Math.max(1000, inv.expiresAt - Date.now()));
  }
  $("btnPInvAccept").onclick = async () => {
    if (!incoming) return; const inv = incoming; incoming = null; $("partyInviteBox").hidden = true;
    const r = await party.respond(inv.id, true); if (!r.ok) { toast(errText(r)); return; } render(); go("party"); render();
  };
  $("btnPInvRefuse").onclick = async () => { if (!incoming) return; const inv = incoming; incoming = null; $("partyInviteBox").hidden = true; await party.respond(inv.id, false); };
  cloud.onRealtime((m) => {
    if (m.t === "party_invite") showInvite({ id: m.id, from: m.from, expiresAt: m.expiresAt });
    else if (m.t === "party_invite_update") { if (incoming && incoming.id === m.id) { $("partyInviteBox").hidden = true; incoming = null; } if (m.status === "accepted") toast(`${m.by.displayName} è entrato nel party`); else if (m.status === "refused") toast(`${m.by.displayName} ha rifiutato`); }
    else if (m.t === "party_update") party.refresh();
    else if (m.t === "party_kicked") { party.exit("kicked").then(() => { toast(m.reason === "blocked" ? "Sei uscito dal party" : "Sei stato rimosso dal party"); render(); }); }
  });
  cloud.on((ev) => {
    if (ev === "login") { party.restore().then(render).catch(() => {}); cloud.api("GET", "/api/party/invites").then((r) => { if (r.ok && r.body.incoming[0]) showInvite({ id: r.body.incoming[0].id, from: r.body.incoming[0].other, expiresAt: r.body.incoming[0].expiresAt }); }); }
    if (ev === "logout" || ev === "anon") party.exit("logout").then(render);
    render();
  });
  party.on(render);
  render();
  return { render, open, invite };
}
