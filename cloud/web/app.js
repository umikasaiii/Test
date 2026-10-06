// DSLink Cloud web client: signalling over WebSocket, media + input over one WebRTC connection.
// The browser never carries DS multiplayer traffic: it only sends button/touch input and plays one slot's audio/video.
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (...ids) => ['menu', 'create', 'join', 'lobby'].forEach((i) => ($(i).hidden = !ids.includes(i)));
  let session = null; // {code, player, token}
  // MULTIPLAYER MODE (developer menu). auto = distributed first, hosted stays a manual fallback. Hosted = the original path (unchanged).
  const modeSel = $('mpMode');
  try { modeSel.value = localStorage.getItem('dslink.mpmode') || 'auto'; } catch { /* storage unavailable */ }
  modeSel.onchange = () => { try { localStorage.setItem('dslink.mpmode', modeSel.value); } catch { /* ignore */ } syncMode(); };
  const distributed = () => modeSel.value !== 'hosted' && location.hash.length <= 1;   // a room link (#CODE) is always a Hosted room
  function syncMode() { $('joinHelp').textContent = distributed() ? 'Inserisci il codice della partita (6 cifre). DSLink trova da solo chi l\'ha creata sulla stessa rete.' : 'Inserisci il codice stanza.'; $('code').maxLength = distributed() ? 6 : 5; }
  syncMode();

  $('btnCreate').onclick = () => { $('menu').hidden = true; show('create'); };
  $('btnJoin').onclick = () => { show('join'); $('code').focus(); };

  $('btnUpload').onclick = async () => {
    const f = $('rom').files[0];
    if (!f) { $('createMsg').innerHTML = '<div class="err">Scegli prima un file .nds</div>'; return; }
    $('createMsg').textContent = 'Creazione stanza… (avvio degli emulatori)';
    const fd = new FormData(); fd.append('rom', f);
    if (distributed()) { fd.append('mode', modeSel.value); fd.append('lan_role', 'host'); }
    const r = await fetch('/api/room', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) { $('createMsg').innerHTML = '<div class="err"></div>'; $('createMsg').firstChild.textContent = j.error; return; }
    session = j;
    if (j.mode === 'distributed') { // the code is all the other player needs; the link/QR text carries the one-time secret for the strong join
      $('roomCode').textContent = j.lan_code || '…';
      $('roomLinkLabel').textContent = 'Codice partita (solo per il debug: link di join con segreto):';
      $('roomLink').textContent = j.lan_uri || '';
    } else {
      $('roomCode').textContent = j.code;
      $('roomLink').textContent = location.origin + '/#' + j.code;
    }
    show('lobby');
  };
  $('btnStart').onclick = () => start();

  async function enter(code) {
    if (distributed()) { // Distributed guest: start THIS device's own console as a DS Download Play client; discovery finds the host on the LAN
      $('joinMsg').textContent = 'Cerco la partita sulla rete…';
      const fd = new FormData(); fd.append('mode', modeSel.value); fd.append('lan_role', 'guest'); fd.append('lan_code', code.trim());
      if (location.search.includes('lan_discovery_addr=')) { const q = new URLSearchParams(location.search); fd.append('lan_discovery_addr', q.get('lan_discovery_addr')); if (q.get('lan_discovery_port')) fd.append('lan_discovery_port', q.get('lan_discovery_port')); }
      const r = await fetch('/api/room', { method: 'POST', body: fd }); const j = await r.json();
      if (!r.ok) { $('joinMsg').innerHTML = '<div class="err"></div>'; $('joinMsg').firstChild.textContent = j.error; return; }
      session = j; start(); return;
    }
    const r = await fetch('/api/join', { method: 'POST', body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok) { $('joinMsg').innerHTML = '<div class="err"></div>'; $('joinMsg').firstChild.textContent = j.error; return; }
    session = j;
    start();
  }
  $('btnEnter').onclick = () => enter($('code').value);
  if (location.hash.length > 1) { show('join'); $('code').value = location.hash.slice(1).toUpperCase(); }

  window.__dslinkStart = (s) => { session = s; return start(); }; // test hook (automated browser tests)

  // ---------------------------------------------------------------------------------------------- WebRTC
  async function start() {
    $('home').hidden = true;
    $('player').classList.add('on');
    const cfg = await (await fetch('/api/config')).json();
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [], iceTransportPolicy: cfg.iceTransportPolicy || 'all' });
    // two channels: discrete events must be reliable+ordered; touch-move samples are replaceable, so unordered/no-retransmit (lowest latency)
    const dc = pc.createDataChannel('input', { ordered: true });
    const dcMove = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const video = $('screen');
    pc.ontrack = (e) => {
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      video.play().catch(() => {});
    };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?code=${session.code}&player=${session.player}&token=${session.token}`);
    ws.onmessage = async (m) => {
      const s = JSON.parse(m.data);
      if (s.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
      else if (s.type === 'candidate' && s.candidate) await pc.addIceCandidate(s.candidate);
    };
    pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.toJSON() })); };
    ws.onopen = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
    };
    const send = (o, ch = dc) => { if (ch.readyState === 'open') ch.send(JSON.stringify(o)); };
    const api = { pc, dc, dcMove, ws, video, session, btn: (k, d) => send({ t: 'btn', k, d }), touch: (x, y, d, m) => send({ t: 'touch', x, y, d, m }, m ? dcMove : dc) }; // x,y: 0..1 over the WHOLE frame (both screens)
    window.dslink = api;
    $('hud').textContent = `Giocatore ${session.player}`;

    // on-screen pad
    document.querySelectorAll('#pad .k').forEach((b) => {
      const k = b.dataset.k;
      const down = (e) => { e.preventDefault(); b.classList.add('on'); api.btn(k, true); };
      const up = (e) => { e.preventDefault(); b.classList.remove('on'); api.btn(k, false); };
      b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
    });
    // keyboard (same layout as RetroArch defaults, so desktop players feel at home)
    const kmap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', x: 'a', z: 'b', s: 'x', a: 'y', q: 'l', w: 'r', Enter: 'start', Shift: 'select' };
    window.addEventListener('keydown', (e) => { const k = kmap[e.key]; if (k && !e.repeat) { e.preventDefault(); api.btn(k, true); } });
    window.addEventListener('keyup', (e) => { const k = kmap[e.key]; if (k) { e.preventDefault(); api.btn(k, false); } });
    // touch screen = lower half of the video
    let touching = false;
    const pos = (e) => {
      const r = video.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      return [nx, ny, ny >= 0.5]; // whole-frame coordinates; only the lower half (touch screen) starts a touch
    };
    video.addEventListener('pointerdown', (e) => { const [x, y, ok] = pos(e); if (!ok) return; touching = true; video.setPointerCapture(e.pointerId); api.touch(x, y, false, true); api.touch(x, y, true, false); });
    video.addEventListener('pointermove', (e) => { if (!touching) return; const [x, y] = pos(e); api.touch(x, Math.max(0.5, y), true, true); });
    const end = (e) => { if (!touching) return; touching = false; const [x, y] = pos(e); api.touch(x, Math.max(0.5, y), false, false); };
    video.addEventListener('pointerup', end); video.addEventListener('pointercancel', end);
  }
})();
