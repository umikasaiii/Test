// Game screen: one WebRTC connection to the container's DSLink Runtime (video + audio in, input out).
// Signalling goes through the Worker (authenticated, membership checked): /api/sessions/:id/signal.
export async function startGame({ sessionId, info, api, onExit }) {
  const root = document.createElement("div"); root.id = "game";
  const video = document.createElement("video"); video.playsInline = true; video.autoplay = true; video.muted = false;
  const hud = document.createElement("div"); hud.className = "hud";
  const label = document.createElement("span"); label.textContent = `Giocatore ${info.slot} · ${info.title}`;
  const quit = document.createElement("button"); quit.className = "small"; quit.textContent = "Esci";
  hud.append(label, quit);
  const pad = document.createElement("div"); pad.className = "pad";
  const keys = [["up", "▲", 60, 90], ["down", "▼", 60, 10], ["left", "◀", 8, 50], ["right", "▶", 112, 50], ["a", "A", 0, 80, "r"], ["b", "B", 60, 40, "r"], ["x", "X", 60, 120, "r"], ["y", "Y", 120, 80, "r"], ["l", "L", 8, 140, "wl"], ["r", "R", 8, 140, "wr"], ["select", "SEL", 80, 4, "wc"], ["start", "START", 6, 4, "wc2"]];
  const place = (el, k, x, y, side) => { el.style.bottom = y + "px"; if (side === "r" || side === "wr") el.style.right = x + "px"; else el.style.left = x + "px"; };
  const sent = [];
  root.append(video, hud, pad);
  document.body.append(root);
  document.getElementById("app").hidden = true;

  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
  const dc = pc.createDataChannel("input", { ordered: true });
  const dcMove = pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (e) => { if (!video.srcObject) video.srcObject = new MediaStream(); video.srcObject.addTrack(e.track); video.play().catch(() => {}); };
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sessions/${sessionId}/signal`);
  ws.onmessage = async (m) => { const s = JSON.parse(m.data); if (s.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: s.sdp }); else if (s.type === "candidate" && s.candidate) await pc.addIceCandidate(s.candidate); };
  pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate.toJSON() })); };
  ws.onopen = async () => { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp })); };

  const send = (o, ch = dc) => { if (ch.readyState === "open") ch.send(JSON.stringify(o)); };
  const btn = (k, d) => send({ t: "btn", k, d });
  const touch = (x, y, d, m) => send({ t: "touch", x, y, d, m }, m ? dcMove : dc);   // x,y over the WHOLE frame (both screens)
  window.dslinkGame = { pc, dc, dcMove, ws, video, btn, touch, info };

  for (const [k, txt, x, y, side] of keys) {
    const b = document.createElement("div"); b.className = "k" + (side && side.startsWith("w") ? " wide" : ""); b.textContent = txt; b.dataset.k = k;
    if (side === "wc") { b.style.left = "50%"; b.style.marginLeft = "10px"; b.style.bottom = y + "px"; } else if (side === "wc2") { b.style.left = "50%"; b.style.marginLeft = "-74px"; b.style.bottom = y + "px"; } else place(b, k, x, y, side);
    const down = (e) => { e.preventDefault(); b.classList.add("on"); btn(k, true); }, up = (e) => { e.preventDefault(); b.classList.remove("on"); btn(k, false); };
    b.addEventListener("pointerdown", down); b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up); b.addEventListener("pointerleave", up);
    pad.append(b);
  }
  const kmap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", x: "a", z: "b", s: "x", a: "y", q: "l", w: "r", Enter: "start", Shift: "select" };
  const kd = (e) => { const k = kmap[e.key]; if (k && !e.repeat) { e.preventDefault(); btn(k, true); } }, ku = (e) => { const k = kmap[e.key]; if (k) { e.preventDefault(); btn(k, false); } };
  window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);

  let touching = false;
  const pos = (e) => { const r = video.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height; return [Math.min(1, Math.max(0, nx)), ny]; };
  video.addEventListener("pointerdown", (e) => { const [x, y] = pos(e); if (y < 0.5 || y > 1) return; touching = true; video.setPointerCapture(e.pointerId); touch(x, y, false, true); touch(x, y, true, false); });
  video.addEventListener("pointermove", (e) => { if (!touching) return; const [x, y] = pos(e); touch(x, Math.min(1, Math.max(0.5, y)), true, true); });
  const end = (e) => { if (!touching) return; touching = false; const [x, y] = pos(e); touch(x, Math.min(1, Math.max(0.5, y)), false, false); };
  video.addEventListener("pointerup", end); video.addEventListener("pointercancel", end);

  // keep the session alive; if the page is closed the heartbeat stops and the session ends by itself
  const hb = setInterval(() => api("POST", `/api/sessions/${sessionId}/heartbeat`).then((r) => { if (r.status === "ended") leave(); }).catch(() => {}), 20000);
  api("POST", `/api/sessions/${sessionId}/heartbeat`).catch(() => {});
  let left = false;
  function leave() {
    if (left) return; left = true;
    clearInterval(hb); window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
    try { ws.close(); pc.close(); } catch { /* closed */ }
    root.remove(); document.getElementById("app").hidden = false; delete window.dslinkGame; onExit();
  }
  quit.onclick = leave;
}
