// DSLink Cloud web client: signalling over WebSocket, media + input over one WebRTC connection.
// The browser never carries DS multiplayer traffic: it only sends button/touch input and plays one slot's audio/video.
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (...ids) => ['menu', 'create', 'join', 'lobby'].forEach((i) => ($(i).hidden = !ids.includes(i)));
  let session = null; // {code, player, token}

  $('btnCreate').onclick = () => { $('menu').hidden = true; show('create'); };
  $('btnJoin').onclick = () => { show('join'); $('code').focus(); };

  $('btnUpload').onclick = async () => {
    const f = $('rom').files[0];
    if (!f) { $('createMsg').innerHTML = '<div class="err">Scegli prima un file .nds</div>'; return; }
    $('createMsg').textContent = 'Creazione stanza… (avvio degli emulatori)';
    const fd = new FormData(); fd.append('rom', f);
    const r = await fetch('/api/room', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) { $('createMsg').innerHTML = '<div class="err"></div>'; $('createMsg').firstChild.textContent = j.error; return; }
    session = j;
    $('roomCode').textContent = j.code;
    $('roomLink').textContent = location.origin + '/#' + j.code;
    show('lobby');
  };
  $('btnStart').onclick = () => start();

  async function enter(code) {
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
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
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
