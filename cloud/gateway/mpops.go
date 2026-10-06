package main

// Lobby operations (host side, guest side), the peer protocol between the two gateways (/api/lobby/*) and the supervisor that watches the peer.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------- proofs (SESSION AUTH): the code alone is never enough

func hmacHex(key []byte, parts ...string) string {
	m := hmac.New(sha256.New, key)
	for _, p := range parts {
		m.Write([]byte(p))
		m.Write([]byte{0})
	}
	return hex.EncodeToString(m.Sum(nil))
}

func codeKey(code string) []byte {
	h := sha256.Sum256([]byte("dslink-lobby-code-v1:" + code))
	return h[:]
}
func secretKey(secretHex string) []byte {
	b, _ := hex.DecodeString(secretHex)
	h := sha256.Sum256(append([]byte("dslink-lobby-secret-v1:"), b...))
	return h[:]
}

// wrapSecret hands the session secret to a guest that joined by code only: AES-GCM under a key derived from the code and the join nonce.
func wrapSecret(code, nonce, secretHex string) string {
	k := sha256.Sum256([]byte("dslink-wrap-v1:" + code + ":" + nonce))
	blk, _ := aes.NewCipher(k[:])
	g, _ := cipher.NewGCM(blk)
	iv := make([]byte, g.NonceSize())
	copy(iv, []byte(nonce))
	return hex.EncodeToString(g.Seal(nil, iv, []byte(secretHex), []byte("dslink")))
}

func unwrapSecret(code, nonce, wrapped string) (string, bool) {
	k := sha256.Sum256([]byte("dslink-wrap-v1:" + code + ":" + nonce))
	blk, _ := aes.NewCipher(k[:])
	g, _ := cipher.NewGCM(blk)
	iv := make([]byte, g.NonceSize())
	copy(iv, []byte(nonce))
	b, err := hex.DecodeString(wrapped)
	if err != nil {
		return "", false
	}
	p, err := g.Open(nil, iv, b, []byte("dslink"))
	return string(p), err == nil
}

// ---------------------------------------------------------------- HOST: create / cancel

func (m *MpSession) Create(gameID, mode string) *MpErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != MpIdle && m.state != MpEnded && m.state != MpError {
		return mpErr("busy")
	}
	m.srv.mu.Lock()
	busy := m.srv.room != nil
	m.srv.mu.Unlock()
	if busy {
		return mpErr("busy")
	}
	g, path, ok := m.srv.libGet(gameID)
	if !ok {
		return mpErr("no_game")
	}
	if mode != "distributed" && mode != "hosted" {
		mode = "auto"
	}
	m.resetLocked()
	m.go_(MpCreatingRoom)
	m.role, m.game, m.gamePath, m.modeChosen = "host", g, path, mode
	m.roomID, m.code, m.secret = randHexN(4), randCode(), randHexN(16)
	m.hostName = deviceName()
	m.players[0] = &MpPlayer{Name: m.hostName, Role: "host", Connected: true, Ready: true}
	m.created = time.Now()
	m.go_(MpWaitingForPeer)
	m.stopSuper = make(chan struct{})
	go m.supervise(m.stopSuper)
	return nil
}

// Cancel: host closes the room / guest leaves. The other side learns it from the next heartbeat.
func (m *MpSession) Cancel() {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.role == "host" && m.state != MpIdle && m.state != MpEnded:
		m.go_(MpEnded)
		m.err = mpErr("host_closed")
		m.err = nil // the host who cancelled needs no message; guests are told through the lobby status
		m.teardownGameLocked()
		m.keepEnded = true
	case m.role == "guest" && m.token != "" && m.hostAddr != "":
		addr, tok := m.hostAddr, m.token
		go peerPost(addr, "/api/lobby/leave", map[string]any{"token": tok}, nil)
		m.resetLocked()
	default:
		m.resetLocked()
	}
}

// Reset: user acknowledged an end/error screen or left the multiplayer flow.
func (m *MpSession) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.role == "guest" && m.token != "" && m.hostAddr != "" && m.state != MpEnded && m.state != MpError {
		addr, tok := m.hostAddr, m.token
		go peerPost(addr, "/api/lobby/leave", map[string]any{"token": tok}, nil)
	}
	m.resetLocked()
}

// ---------------------------------------------------------------- HOST: peer protocol handlers

type joinReq struct {
	Room  string `json:"room"`
	Name  string `json:"name"`
	Nonce string `json:"nonce"`
	Proof string `json:"proof"`
	Via   string `json:"via"` // code | qr | nearby
	Dev   string `json:"dev"` // this device's own random id: the same device asking twice is idempotent, anyone else finds the room full
	Web   bool   `json:"web"` // the guest is a browser on another device playing through the host's gateway (Hosted only)
}

func (m *MpSession) hostAnnounce() (mpAnnounce, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.role != "host" || (m.state != MpWaitingForPeer && m.state != MpConnected && m.state != MpNetworkCheck && m.state != MpReady) {
		return mpAnnounce{}, false
	}
	n := 0
	for _, p := range m.players {
		if p != nil {
			n++
		}
	}
	return mpAnnounce{Room: m.roomID, Title: m.game.Title, Host: m.hostName, HTTP: m.srv.httpPort, UDP: m.srv.udpPort(), Tag: codeTag(m.code), Players: n}, true
}

func (m *MpSession) handleJoin(w http.ResponseWriter, r *http.Request) {
	var q joinReq
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&q) != nil || q.Nonce == "" {
		jsonOut(w, 400, map[string]string{"error": "bad_request"})
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.role != "host" || m.roomID == "" || q.Room != m.roomID || time.Since(m.created) > mpLobbyTTL || (m.state != MpWaitingForPeer && m.state != MpConnected && m.state != MpNetworkCheck && m.state != MpReady) {
		jsonOut(w, 404, map[string]string{"error": "room_expired"})
		return
	}
	if now.Before(m.lockedUntil) {
		jsonOut(w, 423, map[string]string{"error": "locked"})
		return
	}
	// proof: HMAC under the QR secret, or (code-only join) under a key derived from the code; "nearby" joins have no proof and need the host's approval
	ok := false
	switch q.Via {
	case "qr":
		ok = hmac.Equal([]byte(q.Proof), []byte(hmacHex(secretKey(m.secret), "join", m.roomID, q.Nonce, q.Name)))
	case "code":
		ok = hmac.Equal([]byte(q.Proof), []byte(hmacHex(codeKey(m.code), "join", m.roomID, q.Nonce, q.Name)))
	case "nearby":
		ok = true
	}
	if !ok {
		keep := m.badJoins[:0]
		for _, t := range m.badJoins {
			if now.Sub(t) < 10*time.Second {
				keep = append(keep, t)
			}
		}
		m.badJoins = append(keep, now)
		if len(m.badJoins) >= 8 {
			m.lockedUntil = now.Add(30 * time.Second)
			m.logf("join lockout (too many bad proofs)")
		}
		jsonOut(w, 403, map[string]string{"error": "bad_code"})
		return
	}
	addr, _, _ := net.SplitHostPort(r.RemoteAddr)
	for i := 1; i < len(m.players); i++ { // duplicate join: the same device asking again gets the same answer
		if g := m.players[i]; g != nil && g.addr == addr && g.dev == q.Dev {
			jsonOut(w, 200, m.joinAnswer(q, g, i))
			return
		}
	}
	// capacity: up to two browser guests (Hosted); a phone guest (Distributed) is the only guest of its room
	free, guests, native := -1, 0, false
	for i := 1; i < len(m.players); i++ {
		if g := m.players[i]; g == nil {
			if free < 0 {
				free = i
			}
		} else {
			guests++
			native = native || !g.web
		}
	}
	if free < 0 || native || (guests > 0 && !q.Web) {
		jsonOut(w, 409, map[string]string{"error": "room_full"})
		return
	}
	g := &MpPlayer{Name: q.Name, Role: "guest", Connected: true, token: randHexN(16), lastSeen: now, addr: addr, dev: q.Dev, web: q.Web}
	if q.Via == "nearby" {
		g.Pending, g.Connected = true, false
	}
	m.players[free] = g
	m.logf("guest %q (player %d) joined via %s from %s (pending=%v)", q.Name, free+1, q.Via, addr, g.Pending)
	if !g.Pending && (m.state == MpWaitingForPeer) {
		m.go_(MpNetworkCheck)
	}
	m.refreshReadyLocked() // a second guest who is not ready yet takes the room out of READY
	jsonOut(w, 200, m.joinAnswer(q, g, free))
}

func (m *MpSession) joinAnswer(q joinReq, g *MpPlayer, idx int) map[string]any {
	return map[string]any{"token": g.token, "pending": g.Pending, "hostName": m.hostName, "slot": idx}
}

func (m *MpSession) guestByToken(tok string) *MpPlayer {
	_, g := m.guestIdxByToken(tok)
	return g
}

// guestIdxByToken: which guest (1 or 2) holds this private token
func (m *MpSession) guestIdxByToken(tok string) (int, *MpPlayer) {
	if tok == "" {
		return 0, nil
	}
	for i := 1; i < len(m.players); i++ {
		if p := m.players[i]; p != nil && p.token != "" && hmac.Equal([]byte(p.token), []byte(tok)) {
			return i, p
		}
	}
	return 0, nil
}

func (m *MpSession) handleLobbyStatus(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tok := r.URL.Query().Get("token")
	idx, g := m.guestIdxByToken(tok)
	if m.role != "host" || g == nil {
		jsonOut(w, 404, map[string]string{"error": "room_expired"})
		return
	}
	g.lastSeen = time.Now()
	if g.Pending {
		jsonOut(w, 200, map[string]any{"pending": true, "state": m.state})
		return
	}
	pl := make([]any, len(m.players)) // fixed positions: [0] host, [1] and [2] guests (null = empty): a guest knows which one it is and sees the other's name and readiness
	for i, p := range m.players {
		if p != nil {
			pl[i] = map[string]any{"name": p.Name, "role": p.Role, "connected": p.Connected, "ready": p.Ready}
		}
	}
	plan := m.plan // the stream credentials in it are THIS guest's own console only
	if plan.Mode == "hosted" && m.local != nil && g.roomSlot > 0 && g.roomSlot < len(m.local.Tokens) {
		plan.HostedToken, plan.HostedPlayer = m.local.Tokens[g.roomSlot], g.roomSlot+1
	}
	out := map[string]any{"state": m.state, "game": map[string]any{"title": m.game.Title, "id": m.game.ID, "profile": m.game.Profile}, "players": pl, "hostName": m.hostName, "slot": idx,
		"net": map[string]any{"done": m.netDone, "class": m.net.Class}, "mode": m.modeForPeer(),
		"plan": plan, "step": m.step, "error": m.err}
	if m.err != nil || m.state == MpEnded {
		out["error"] = m.err
	}
	if m.state == MpStarting || m.state == MpDownloadPlay || m.state == MpInGame || m.state == MpReconnecting {
		// the game credentials (room code + session secret for the radio link) go only to the joined guest, wrapped under its private token
		out["startKey"] = wrapSecret(g.token, "start", m.code+":"+m.secret)
	}
	jsonOut(w, 200, out)
}

func (m *MpSession) handleLobbyReady(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Token string `json:"token"`
		Ready bool   `json:"ready"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.guestByToken(q.Token)
	if m.role != "host" || g == nil || g.Pending {
		jsonOut(w, 404, map[string]string{"error": "room_expired"})
		return
	}
	g.Ready, g.lastSeen = q.Ready, time.Now()
	m.refreshReadyLocked()
	jsonOut(w, 200, map[string]any{"ok": true, "state": m.state})
}

func (m *MpSession) handleLobbyNet(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Token string      `json:"token"`
		Net   MpNetResult `json:"net"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 2048)).Decode(&q)
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.guestByToken(q.Token)
	if m.role != "host" || g == nil {
		jsonOut(w, 404, map[string]string{"error": "room_expired"})
		return
	}
	m.net, m.netDone = q.Net, true
	m.net.Class = classifyNet(m.net) // never trust a peer's own verdict
	m.logf("netcheck: rtt %.1f ms jitter %.1f loss %.1f%% -> %s", m.net.RttMs, m.net.JitterMs, m.net.LossPct, m.net.Class)
	if m.state == MpNetworkCheck {
		m.go_(MpConnected)
	}
	m.refreshReadyLocked()
	jsonOut(w, 200, map[string]any{"ok": true})
}

func (m *MpSession) handleLobbyReport(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Token string  `json:"token"`
		State MpState `json:"state"`
		Step  string  `json:"step"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q)
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.guestByToken(q.Token)
	if m.role != "host" || g == nil {
		jsonOut(w, 404, map[string]string{"error": "room_expired"})
		return
	}
	g.lobbyOnly, g.lastSeen = string(q.State), time.Now()
	m.checkInGameLocked() // the guest may be the last of the two to finish its setup
	jsonOut(w, 200, map[string]any{"ok": true})
}

func (m *MpSession) handleLobbyLeave(w http.ResponseWriter, r *http.Request) {
	var q struct{ Token string }
	json.NewDecoder(io.LimitReader(r.Body, 512)).Decode(&q)
	m.mu.Lock()
	defer m.mu.Unlock()
	if idx, g := m.guestIdxByToken(q.Token); m.role == "host" && g != nil {
		m.dropGuestLocked(idx, "peer_left")
	}
	jsonOut(w, 200, map[string]any{"ok": true})
}

// refreshReadyLocked: READY = at least one guest connected + network checked + every connected guest ready (the host is ready by definition); anything less = CONNECTED.
// A second guest is optional: START works with one guest or two.
func (m *MpSession) refreshReadyLocked() {
	guests := m.guestIdx(true)
	allReady := len(guests) > 0 && m.netDone
	for _, i := range guests {
		if !m.players[i].Ready {
			allReady = false
		}
	}
	switch {
	case allReady && (m.state == MpConnected || m.state == MpNetworkCheck):
		m.go_(MpReady)
	case !allReady && m.state == MpReady:
		m.go_(MpConnected)
	}
}

// guestGoneLocked: the guest left the LOBBY (before the game). In a running game this is handled by the supervisor (RECONNECTING).
func (m *MpSession) guestGoneLocked(idx int, why string) {
	m.players[idx] = nil
	left := len(m.guestIdx(true))
	if left == 0 {
		m.netDone, m.net = false, MpNetResult{}
	}
	switch m.state {
	case MpConnected, MpNetworkCheck, MpReady:
		if left == 0 {
			m.go_(MpWaitingForPeer)
			m.err = nil
			m.step = "L'altro giocatore si è disconnesso."
		} else {
			m.refreshReadyLocked()
			m.step = "Un giocatore si è disconnesso."
		}
	}
	m.logf("guest %d gone (%s)", idx+1, why)
}

// Approve (host): accept or reject a "nearby" join request.
func (m *MpSession) Approve(accept bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	idx := 0
	for i := 1; i < len(m.players); i++ {
		if g := m.players[i]; g != nil && g.Pending {
			idx = i
			break
		}
	}
	if m.role != "host" || idx == 0 {
		return
	}
	g := m.players[idx]
	if !accept {
		g.token = "" // the guest's next poll finds nothing -> "rejected"
		m.players[idx] = nil
		m.logf("join rejected")
		return
	}
	g.Pending, g.Connected, g.lastSeen = false, true, time.Now()
	if m.state == MpWaitingForPeer {
		m.go_(MpNetworkCheck)
	}
}

// ---------------------------------------------------------------- peer HTTP client

var peerClient = &http.Client{Timeout: 3 * time.Second}

func peerPost(addr, path string, body any, out any) (int, error) {
	b, _ := json.Marshal(body)
	resp, err := peerClient.Post("http://"+addr+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(out)
	}
	return resp.StatusCode, nil
}

func peerGet(addr, path string, out any) (int, error) {
	resp, err := peerClient.Get("http://" + addr + path)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(out)
	}
	return resp.StatusCode, nil
}

// ---------------------------------------------------------------- GUEST: join

type JoinRequest struct {
	Code    string `json:"code"`
	Payload string `json:"payload"` // QR content
	Room    string `json:"room"`    // nearby: room id from /api/mp/nearby
	Addr    string `json:"addr"`    // developer menu only: manual host address
}

var (
	hintMu sync.Mutex
	hints  []string
)

// mpSetHints replaces the extra unicast discovery targets (valid IPv4 only, at most 16): the platform's own discovery (Android NSD) feeds them in.
func mpSetHints(addrs []string) {
	var ok []string
	for _, a := range addrs {
		if ip := net.ParseIP(strings.TrimSpace(a)); ip != nil && ip.To4() != nil && len(ok) < 16 {
			ok = append(ok, ip.String())
		}
	}
	hintMu.Lock()
	hints = ok
	hintMu.Unlock()
}

func discoveryAddrs() []string {
	a := []string{"255.255.255.255"}
	hintMu.Lock()
	a = append(a, hints...)
	hintMu.Unlock()
	netOverride.Lock()
	if netOverride.broadcast != "" {
		a = append(a, netOverride.broadcast) // the subnet's directed broadcast reaches more Wi-Fi chipsets than the limited 255.255.255.255
	}
	netOverride.Unlock()
	if v := os.Getenv("DSLINK_MP_DISCOVERY_ADDR"); v != "" {
		a = append(a, strings.Split(v, ",")...)
	}
	return a
}

func (m *MpSession) Nearby() []map[string]any {
	res := mpDiscover(discoveryAddrs(), mpPort(), "", 1500*time.Millisecond)
	out := []map[string]any{}
	for _, a := range res {
		out = append(out, map[string]any{"room": a.Room, "title": a.Title, "host": a.Host, "players": a.Players, "addr": net.JoinHostPort(a.Addr, fmt.Sprint(a.HTTP)), "udp": a.UDP})
	}
	return out
}

func (m *MpSession) Join(req JoinRequest) *MpErr {
	m.mu.Lock()
	if m.state != MpIdle && m.state != MpEnded && m.state != MpError {
		m.mu.Unlock()
		return mpErr("busy")
	}
	if !m.web { // a web guest owns no console: the host's room in the same gateway is not "busy" for it
		m.srv.mu.Lock()
		busy := m.srv.room != nil
		m.srv.mu.Unlock()
		if busy {
			m.mu.Unlock()
			return mpErr("busy")
		}
	}
	m.resetLocked()
	m.role = "guest"
	m.go_(MpJoining)
	m.step = "Cerco la partita…"
	name := deviceName()
	if m.web {
		name = webDeviceName(m.webUA)
	}
	m.mu.Unlock()

	fail := func(code string) *MpErr { // a failed join returns to the Join screen with the message inline (no dead-end error screen)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.logf("join failed: %s", code)
		m.resetLocked()
		return mpErr(code)
	}

	var code, secret, hostAddr, room, via string
	hostUDP := 0
	if m.web { // the host is this very gateway: no discovery, the code (or the QR's secret) is still what proves the guest knows the room
		c, sct, ha, rm, vi, hu, e := m.resolveLocalHost(req)
		if e != nil {
			return fail(e.Code)
		}
		code, secret, hostAddr, room, via, hostUDP = c, sct, ha, rm, vi, hu
	} else {
		switch {
		case req.Payload != "":
			c, s, h, r, u, ok := parseJoinPayload(req.Payload)
			if !ok {
				return fail("bad_code")
			}
			code, secret, hostAddr, room, via, hostUDP = c, s, h, r, "qr", u
		case req.Room != "":
			via = "nearby"
			for _, n := range m.Nearby() {
				if n["room"] == req.Room {
					hostAddr, room = n["addr"].(string), req.Room
					hostUDP, _ = n["udp"].(int)
				}
			}
			if hostAddr == "" {
				return fail("peer_not_found")
			}
		case req.Addr != "": // developer menu: manual address + code
			via, code, hostAddr = "code", req.Code, req.Addr
		case len(req.Code) == 6:
			via, code = "code", req.Code
			found := mpDiscover(discoveryAddrs(), mpPort(), codeTag(code), 2000*time.Millisecond)
			if len(found) == 0 {
				if len(mpDiscover(discoveryAddrs(), mpPort(), "", 1000*time.Millisecond)) > 0 {
					return fail("bad_code") // rooms exist here, none with this code
				}
				return fail("peer_not_found")
			}
			hostAddr, room, hostUDP = net.JoinHostPort(found[0].Addr, fmt.Sprint(found[0].HTTP)), found[0].Room, found[0].UDP
		default:
			return fail("bad_code")
		}
	}
	nonce := randHexN(8)
	body := joinReq{Room: room, Name: name, Nonce: nonce, Via: via, Dev: m.devID, Web: m.web}
	if via == "qr" {
		body.Proof = hmacHex(secretKey(secret), "join", room, nonce, name)
	} else if via == "code" {
		body.Proof = hmacHex(codeKey(code), "join", room, nonce, name)
	}
	if room == "" && req.Addr != "" { // manual address: learn the room id from the host's announcement
		for _, a := range mpDiscover([]string{strings.Split(hostAddr, ":")[0]}, mpPort(), "", 800*time.Millisecond) {
			body.Room = a.Room
			body.Proof = hmacHex(codeKey(code), "join", a.Room, nonce, name)
		}
	}
	var ans struct {
		Token, Wrapped, HostName string
		Pending                  bool
		Error                    string
		Slot                     int
	}
	st, err := peerPost(hostAddr, "/api/lobby/join", body, &ans)
	if err != nil {
		return fail("network_isolated")
	}
	switch st {
	case 200:
	case 403:
		return fail("bad_code")
	case 404:
		return fail("room_expired")
	case 409:
		return fail("room_full")
	case 423:
		return fail("locked")
	default:
		return fail("internal")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.hostAddr, m.hostIP, m.token, m.hostName, m.code = hostAddr, strings.Split(hostAddr, ":")[0], ans.Token, ans.HostName, code
	m.lastJoin = req
	m.roomID, m.hostSeen, m.hostUDP = body.Room, time.Now(), hostUDP
	if secret != "" {
		m.secret = secret
	}
	if ans.Slot < 1 || ans.Slot >= len(m.players) {
		ans.Slot = 1
	}
	m.slot = ans.Slot
	m.players[0] = &MpPlayer{Name: ans.HostName, Role: "host", Connected: true, Ready: true}
	m.players[ans.Slot] = &MpPlayer{Name: name, Role: "guest", Connected: !ans.Pending, Pending: ans.Pending}
	if ans.Pending {
		m.step = "In attesa che l'host accetti…"
	} else {
		m.go_(MpConnected)
		m.step = ""
	}
	m.stopSuper = make(chan struct{})
	go m.guestLoop(m.stopSuper, nonce)
	return nil
}

// Ready (guest): toggles the ready flag at the host.
func (m *MpSession) SetReady(ready bool) *MpErr {
	m.mu.Lock()
	if m.role != "guest" || m.token == "" || (m.state != MpConnected && m.state != MpNetworkCheck && m.state != MpReady) {
		m.mu.Unlock()
		return mpErr("not_ready")
	}
	addr, tok := m.hostAddr, m.token
	if p := m.players[m.slot]; p != nil {
		p.Ready = ready
	}
	m.mu.Unlock()
	peerPost(addr, "/api/lobby/ready", map[string]any{"token": tok, "ready": ready}, nil)
	return nil
}

func (m *MpSession) modeForPeer() map[string]any {
	eff, note := m.modeEffective, m.modeNote
	if eff == "" && m.netDone {
		eff, note = m.decideMode()
	}
	return map[string]any{"chosen": m.modeChosen, "effective": eff, "note": note}
}
