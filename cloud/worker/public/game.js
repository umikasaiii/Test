// Game screen: one WebRTC connection to the container's DSLink Runtime (video + audio in, input out).
// Signalling goes through the Worker (authenticated, membership checked): /api/sessions/:id/signal.
import { mountControls } from "/controls/controls.js";

export async function startGame({ sessionId, info, api, onExit }) {
  const root = document.createElement("div"); root.id = "game";
  const video = document.createElement("video"); video.playsInline = true; video.autoplay = true; video.muted = false;
  root.append(video);
  document.body.append(root);
  document.getElementById("app").hidden = true;

  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [], iceTransportPolicy: cfg.iceTransportPolicy || "all" });
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
  window.dslinkGame = { pc, dc, dcMove, ws, video, btn, touch, info, get controls() { return controls; } };

  // touch controls: layout / visuals / input are separate modules (controls/*.js); the game only supplies a sink
  const controls = mountControls({ container: root, video, platform: info.platform || "nds", persist: true, onLeave: () => leave(),
    sink: { btn, stylus: (x, y, d, m) => touch(x, y, d, m), ui() {} } });
  const kmap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", x: "a", z: "b", s: "x", a: "y", q: "l", w: "r", Enter: "start", Shift: "select" };
  const kd = (e) => { const k = kmap[e.key]; if (k && !e.repeat) { e.preventDefault(); btn(k, true); } }, ku = (e) => { const k = kmap[e.key]; if (k) { e.preventDefault(); btn(k, false); } };
  window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);

  // keep the session alive; if the page is closed the heartbeat stops and the session ends by itself
  const hb = setInterval(() => api("POST", `/api/sessions/${sessionId}/heartbeat`).then((r) => { if (r.status === "ended") leave(); }).catch(() => {}), 20000);
  api("POST", `/api/sessions/${sessionId}/heartbeat`).catch(() => {});
  let left = false;
  function leave() {
    if (left) return; left = true;
    controls.destroy(); clearInterval(hb); window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
    try { ws.close(); pc.close(); } catch { /* closed */ }
    root.remove(); document.getElementById("app").hidden = false; delete window.dslinkGame; onExit();
  }
}
