package main

// Start flow, game launch, supervision and recovery.

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) firmwareOK() bool {
	d := s.env.FirmwareDir
	if d == "" {
		return false
	}
	for _, f := range []string{"bios7.bin", "bios9.bin", "firmware.bin"} {
		if _, err := os.Stat(filepath.Join(d, f)); err != nil {
			return false
		}
	}
	return true
}

func testGuestRom() string { return os.Getenv("DSLINK_TEST_GUEST_ROM") } // tests only: a guest cartridge for homebrew radio tests (real guests have none)

// decideMode: the user normally gets AUTOMATIC. Distributed only on a clearly good network; otherwise Hosted. The developer menu can force either.
func (m *MpSession) decideMode() (string, string) {
	switch m.modeChosen {
	case "distributed":
		return "distributed", ""
	case "hosted":
		return "hosted", ""
	}
	if m.netDone && m.net.Class == "GREEN" {
		return "distributed", ""
	}
	if m.srv.env.NoEncoder { // this build cannot stream a console to another device: Hosted is not available here
		return "distributed", ""
	}
	_, hint := netLabel(m.net.Class)
	if hint == "" {
		hint = "Per maggiore stabilità verrà utilizzata la modalità Hosted."
	}
	return "hosted", hint
}

// Start (host): both ready -> pick the mode, launch what this device owns, publish the plan to the guest.
func (m *MpSession) Start() *MpErr {
	m.mu.Lock()
	if m.role != "host" || m.state != MpReady {
		m.mu.Unlock()
		return mpErr("not_ready")
	}
	if m.game.Profile != "" && !m.srv.firmwareOK() {
		m.mu.Unlock()
		return mpErr("no_firmware")
	}
	eff, note := m.decideMode()
	m.modeEffective, m.modeNote = eff, note
	m.go_(MpStarting)
	m.step = "Preparazione partita…"
	m.attempt = 1
	m.guestAttempt = 0
	m.plan = mpPlan{Mode: eff, Seq: m.plan.Seq + 1, Attempt: 1}
	m.radioSeen = false
	m.stopDrv = make(chan struct{})
	stop := m.stopDrv
	m.mu.Unlock()
	go m.hostLaunch(eff, stop)
	return nil
}

func (m *MpSession) setStep(step string) {
	m.mu.Lock()
	m.step = step
	m.mu.Unlock()
}

func (m *MpSession) failStart(code string, why error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if why != nil {
		m.logf("start failed: %v", why)
	}
	m.teardownGameLocked()
	m.go_(MpError)
	m.err = mpErr(code)
}

func (m *MpSession) hostLaunch(mode string, stop chan struct{}) {
	m.mu.Lock()
	rom, title, profile, code, secret, gen := m.gamePath, m.game.Title, m.game.Profile, m.code, m.secret, m.attempt
	m.mu.Unlock()
	room := &Room{Code: roomCode(), Title: title, Created: time.Now()}
	m.setStep("Avvio Nintendo DS…")
	if mode == "distributed" {
		room.Solo = true
		room.Lan = &LanSpec{Role: "host", Code: code, Secret: secret, GraceMs: 10000, Bind: os.Getenv("DSLINK_MP_BIND"), Advertise: advertiseIP(), Mode: "distributed"}
	}
	if err := m.srv.startSlots(room, rom, func() string {
		if mode == "hosted" {
			return testGuestRom()
		}
		return ""
	}()); err != nil {
		for _, sl := range room.Slots {
			if sl != nil {
				sl.Stop()
			}
		}
		m.failStart("start_failed", err)
		return
	}
	room.Tokens[0], room.Tokens[1] = randHex(8), randHex(8)
	m.srv.mu.Lock()
	m.srv.room = room
	m.srv.mu.Unlock()
	m.mu.Lock()
	if m.state != MpStarting { // cancelled while launching
		m.mu.Unlock()
		m.srv.closeRoom()
		return
	}
	m.local = room
	if mode == "hosted" {
		m.plan.HostedCode, m.plan.HostedToken = room.Code, room.Tokens[1]
		m.step = "Connessione al secondo giocatore…"
	}
	m.mu.Unlock()
	if mode == "distributed" {
		for i := 0; i < 80; i++ { // the runtime reports the LAN data port once its socket is open
			st := room.Slots[0].Status()
			if p, _ := st["lan_port"].(float64); p > 0 {
				m.mu.Lock()
				m.plan.LanPort = int(p)
				m.plan.Seq++
				m.mu.Unlock()
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	// the DS-level setup: nothing to do for homebrew; the Download Play assistant for known games
	if profile == "" {
		m.waitRadioThenInGame(mode, stop)
		return
	}
	m.mu.Lock()
	m.go_(MpDownloadPlay)
	m.step = "Ricerca partita…"
	m.mu.Unlock()
	go func() {
		err := m.runHostDriver(room, mode, profile, stop)
		if err != nil {
			select {
			case <-stop:
			default:
				m.setupFailed(mode, gen, err)
			}
			return
		}
		m.driverDone(true)
	}()
	if mode == "hosted" { // both consoles live here: the guest's DS menu is driven on this device too
		go func() {
			if err := m.runGuestDriver(room.Slots[1], profile, stop); err != nil {
				select {
				case <-stop:
				default:
					m.setupFailed(mode, gen, err)
				}
				return
			}
			m.driverDone(false)
		}()
	}
}

// setupFailed: the DS-level setup (Download Play) did not complete. The first time the whole setup is redone quietly (consoles restarted, same session,
// the guest device follows when it sees the attempt grow); the second time the user is told. Older attempts and a session that moved on are ignored.
func (m *MpSession) setupFailed(mode string, gen int, err error) {
	m.mu.Lock()
	if gen != m.attempt || m.state != MpDownloadPlay {
		m.mu.Unlock()
		return
	}
	if m.attempt >= mpSetupAttempts {
		m.mu.Unlock()
		m.failStart("setup_timeout", err)
		return
	}
	m.logf("setup attempt %d failed: %v - trying again", m.attempt, err)
	if m.stopDrv != nil {
		close(m.stopDrv)
	}
	m.stopDrv = make(chan struct{})
	stop := m.stopDrv
	m.attempt++
	m.plan.Attempt, m.plan.LanPort = m.attempt, 0
	m.plan.Seq++
	m.hostDriverOK, m.guestDriverOK, m.radioSeen = false, false, false
	m.local = nil
	m.go_(MpStarting)
	m.step = "Preparazione partita…"
	m.mu.Unlock()
	m.srv.closeRoom()
	go m.hostLaunch(mode, stop)
}

// driverDone: host side reaches IN_GAME when the host's driver finished and the guest side too (hosted: its own driver; distributed: the guest reports).
func (m *MpSession) driverDone(host bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if host {
		m.hostDriverOK = true
	} else {
		m.guestDriverOK = true
	}
	m.checkInGameLocked()
}

func (m *MpSession) checkInGameLocked() {
	if m.state != MpDownloadPlay && m.state != MpStarting {
		return
	}
	if m.role == "guest" {
		if m.guestDriverOK || m.plan.Mode == "hosted" && m.hostState == MpInGame {
			m.go_(MpInGame)
			m.step = ""
		}
		return
	}
	g := m.players[1]
	guestOK := m.guestDriverOK || (m.plan.Mode == "distributed" && g != nil && g.lobbyOnly == string(MpInGame))
	if m.hostDriverOK && guestOK {
		m.go_(MpInGame)
		m.step = ""
	}
}

// waitRadioThenInGame: games without an assistant (tests): IN_GAME once the consoles are linked.
func (m *MpSession) waitRadioThenInGame(mode string, stop chan struct{}) {
	for i := 0; i < 600; i++ {
		select {
		case <-stop:
			return
		default:
		}
		m.mu.Lock()
		room := m.local
		ok := false
		if room != nil && room.Slots[0] != nil {
			st := room.Slots[0].Status()
			peers, _ := st["mp_peers"].(float64)
			if mode == "hosted" {
				ok = peers >= 1
			} else {
				g := m.players[1]
				ok = peers >= 1 && g != nil && g.lobbyOnly == string(MpInGame)
			}
		}
		if ok {
			m.go_(MpInGame)
			m.step = ""
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()
		time.Sleep(200 * time.Millisecond)
	}
	m.failStart("setup_timeout", nil)
}

// ---------------------------------------------------------------- GUEST

func (m *MpSession) guestLoop(stop chan struct{}, nonce string) {
	netStarted := false
	for {
		select {
		case <-stop:
			return
		case <-time.After(600 * time.Millisecond):
		}
		m.mu.Lock()
		addr, tok, st := m.hostAddr, m.token, m.state
		m.mu.Unlock()
		if st == MpIdle || st == MpEnded || st == MpError && m.err != nil && st != MpError {
			return
		}
		var hs struct {
			Pending bool
			State   MpState
			Game    struct{ Title, ID, Profile string }
			Players []MpPlayer
			Net     struct {
				Done  bool
				Class string
			}
			Mode     struct{ Chosen, Effective, Note string }
			Plan     mpPlan
			Step     string
			Error    *MpErr
			StartKey string
		}
		code, err := peerGet(addr, "/api/lobby/status?token="+tok, &hs)
		now := time.Now()
		m.mu.Lock()
		if err == nil && code == 200 {
			m.hostSeen = now
		}
		switch {
		case err == nil && code == 404:
			if p := m.players[1]; p != nil && p.Pending {
				m.go_(MpError)
				m.err = mpErr("rejected")
			} else if m.state != MpEnded && m.state != MpError {
				m.endLocked("host_closed")
			}
			m.mu.Unlock()
			return
		case err != nil || code != 200:
			if now.Sub(m.hostSeen) > mpPeerDeadMs*time.Millisecond {
				m.hostLostLocked()
			}
			m.mu.Unlock()
			continue
		}
		if hs.Pending {
			m.mu.Unlock()
			continue
		}
		if p := m.players[1]; p != nil && p.Pending {
			p.Pending, p.Connected = false, true
			m.go_(MpConnected)
			m.step = ""
		}
		// mirror the host's view
		m.game = LibGame{ID: hs.Game.ID, Title: hs.Game.Title, Profile: hs.Game.Profile}
		m.players[0] = &MpPlayer{Name: hs.Players[0].Name, Role: "host", Connected: true, Ready: true}
		m.net, m.netDone = MpNetResult{Class: hs.Net.Class}, hs.Net.Done
		m.modeChosen, m.modeEffective, m.modeNote = hs.Mode.Chosen, hs.Mode.Effective, hs.Mode.Note
		m.hostState, m.plan = hs.State, hs.Plan
		if hs.Plan.Attempt > m.guestAttempt { // the host redoes the setup: this device's console is restarted too (it relaunches below once the new port is published)
			if m.started && hs.Plan.Mode == "distributed" {
				m.logf("host restarts the setup (attempt %d)", hs.Plan.Attempt)
				if m.stopDrv != nil {
					close(m.stopDrv)
					m.stopDrv = nil
				}
				m.local, m.started = nil, false
				m.mu.Unlock() // stopping the console takes a moment: keep answering the host's heartbeat meanwhile
				m.srv.closeRoom()
				m.mu.Lock()
			}
			m.guestAttempt = hs.Plan.Attempt
		}
		if hs.State == MpEnded || hs.State == MpError {
			reason := "host_closed"
			if hs.Error != nil && hs.Error.Code != "" {
				reason = hs.Error.Code
			}
			m.endLocked(reason)
			m.mu.Unlock()
			return
		}
		if m.state == MpReconnecting && hs.State != MpReconnecting {
			if now.Sub(m.reconnectSince) < mpReconnectGrace*time.Millisecond && m.prevState != "" {
				m.go_(m.prevState)
				m.logf("host back, resuming %s", m.prevState)
			}
		}
		// lobby actions
		if m.state == MpConnected && !netStarted {
			netStarted = true
			m.go_(MpNetworkCheck)
			go m.guestNetCheck(addr, tok, m.hostUDP)
		}
		// the guest's lobby state mirrors the host's READY (both ready, network checked)
		if hs.State == MpReady && m.state == MpConnected {
			m.go_(MpReady)
		} else if hs.State == MpConnected && m.state == MpReady {
			m.go_(MpConnected)
		}
		launch := (hs.State == MpStarting || hs.State == MpDownloadPlay || hs.State == MpInGame) && hs.Plan.Mode != "" && !m.started
		if launch && m.state != MpStarting && m.state != MpDownloadPlay && m.state != MpInGame {
			if m.state == MpConnected || m.state == MpNetworkCheck {
				m.go_(MpReady) // a poll can miss the READY moment: pass through it so the machine stays honest
			}
			m.go_(MpStarting)
			m.step = "Preparazione partita…"
		}
		if launch && hs.Plan.Mode == "hosted" {
			m.started = true
			m.step = "Connessione al secondo giocatore…"
			m.mu.Unlock()
			continue
		}
		if launch && hs.Plan.Mode == "distributed" && hs.Plan.LanPort > 0 && hs.StartKey != "" {
			m.started = true
			m.stopDrv = make(chan struct{})
			drv := m.stopDrv
			plan, startKey, hostIP, profile := hs.Plan, hs.StartKey, m.hostIP, hs.Game.Profile
			m.mu.Unlock()
			go m.guestLaunch(plan, startKey, tok, hostIP, profile, drv)
			continue
		}
		if m.plan.Mode == "hosted" && m.started {
			switch hs.State {
			case MpDownloadPlay:
				if m.state == MpStarting {
					m.go_(MpDownloadPlay)
					m.step = "Download Play…"
				}
			case MpInGame:
				if m.state != MpInGame {
					m.go_(MpInGame)
					m.step = ""
				}
			}
		}
		m.mu.Unlock()
		// heartbeat/report back to the host (what this guest is doing)
		m.mu.Lock()
		mine := m.state
		m.mu.Unlock()
		peerPost(addr, "/api/lobby/report", map[string]any{"token": tok, "state": mine}, nil)
		if m.guestRuntimeEnded() {
			m.mu.Lock()
			m.endLocked("peer_lost")
			m.mu.Unlock()
			return
		}
	}
}

func (m *MpSession) guestRuntimeEnded() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.local == nil || m.local.Slots[0] == nil || (m.state != MpInGame && m.state != MpDownloadPlay) {
		return false
	}
	st := m.local.Slots[0].Status()
	e, _ := st["mp_ended"].(string)
	open, _ := st["runtime_link_open"].(bool)
	return e != "" || !open // the radio session ended, or this device's own console process died
}

func (m *MpSession) guestNetCheck(addr, tok string, udp int) {
	host := strings.Split(addr, ":")[0]
	if udp == 0 {
		udp = mpPort()
	}
	res := mpNetCheck(host, udp, 40, 20*time.Millisecond)
	m.mu.Lock()
	m.net, m.netDone = res, true
	if m.state == MpNetworkCheck {
		m.go_(MpConnected)
	}
	m.mu.Unlock()
	peerPost(addr, "/api/lobby/net", map[string]any{"token": tok, "net": res}, nil)
}

func (m *MpSession) guestLaunch(plan mpPlan, startKey, tok, hostIP, profile string, stop chan struct{}) {
	creds, ok := unwrapSecret(tok, "start", startKey)
	parts := strings.SplitN(creds, ":", 2)
	if !ok || len(parts) != 2 {
		m.failStart("start_failed", nil)
		return
	}
	if profile != "" && !m.srv.firmwareOK() {
		m.failStart("no_firmware", nil)
		return
	}
	m.setStep("Avvio Nintendo DS…")
	room := &Room{Code: roomCode(), Title: "DS Download Play", Created: time.Now(), Solo: true}
	room.Lan = &LanSpec{Role: "guest", Code: parts[0], Secret: parts[1], HostAddr: hostIP + ":" + itoa(plan.LanPort), Bind: os.Getenv("DSLINK_MP_BIND"), Mode: "distributed"}
	if err := m.srv.startSlots(room, testGuestRom(), ""); err != nil {
		m.failStart("start_failed", err)
		return
	}
	room.Tokens[0], room.Tokens[1] = randHex(8), randHex(8)
	m.srv.mu.Lock()
	m.srv.room = room
	m.srv.mu.Unlock()
	m.mu.Lock()
	if m.state == MpIdle || m.state == MpEnded || m.state == MpError {
		m.mu.Unlock()
		m.srv.closeRoom()
		return
	}
	m.local = room
	m.step = "Connessione al secondo giocatore…"
	m.mu.Unlock()
	if profile == "" {
		for i := 0; i < 600; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if peers, _ := room.Slots[0].Status()["mp_active"].(bool); peers {
				m.mu.Lock()
				m.go_(MpInGame)
				m.step = ""
				m.mu.Unlock()
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		m.failStart("setup_timeout", nil)
		return
	}
	m.mu.Lock()
	m.go_(MpDownloadPlay)
	m.step = "Ricerca partita…"
	m.mu.Unlock()
	if err := m.runGuestDriver(room.Slots[0], profile, stop); err != nil {
		select {
		case <-stop:
		default:
			m.failStart("setup_timeout", err)
		}
		return
	}
	m.mu.Lock()
	m.guestDriverOK = true
	m.go_(MpInGame)
	m.step = ""
	m.mu.Unlock()
}

// ---------------------------------------------------------------- supervision, loss and recovery

// endLocked: the game/lobby is over for a stated reason. Resources are freed; the user decides (back to lobby / close).
func (m *MpSession) endLocked(reason string) {
	m.teardownGameLocked()
	if m.stopDrv != nil {
		close(m.stopDrv)
		m.stopDrv = nil
	}
	if m.state == MpIdle {
		return
	}
	m.go_(MpEnded)
	m.err = mpErr(reason)
	m.step = ""
	m.logf("ended: %s", reason)
}

func (m *MpSession) hostLostLocked() {
	switch m.state {
	case MpStarting, MpDownloadPlay, MpInGame:
		m.prevState, m.reconnectSince = m.state, time.Now()
		m.go_(MpReconnecting)
		m.step = "Connessione persa. Riconnessione in corso…"
	case MpReconnecting:
		if time.Since(m.reconnectSince) > mpReconnectGrace*time.Millisecond {
			m.endLocked("peer_lost")
		}
	case MpConnected, MpNetworkCheck, MpReady, MpJoining:
		m.endLocked("host_closed")
	}
}

func (m *MpSession) supervise(stop chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case <-time.After(500 * time.Millisecond):
		}
		m.mu.Lock()
		if m.role != "host" {
			m.mu.Unlock()
			return
		}
		now := time.Now()
		g := m.players[1]
		switch m.state {
		case MpWaitingForPeer, MpConnected, MpNetworkCheck, MpReady:
			if now.Sub(m.created) > mpLobbyTTL {
				m.endLocked("room_expired")
			} else if g != nil && !g.Pending && now.Sub(g.lastSeen) > mpPeerDeadMs*time.Millisecond {
				m.guestGoneLocked("heartbeat")
			} else if g != nil && g.Pending && now.Sub(g.lastSeen) > 10*time.Second {
				m.players[1] = nil // the asking guest went away
			} else if m.state == MpNetworkCheck && g != nil && now.Sub(g.lastSeen) < time.Second && !m.netDone && now.Sub(m.created) > 0 {
				// waiting for the guest's measurement
			}
		case MpStarting, MpDownloadPlay, MpInGame, MpReconnecting:
			alive := g != nil && now.Sub(g.lastSeen) < mpPeerDeadMs*time.Millisecond
			if m.plan.Mode == "distributed" && m.local != nil && m.local.Slots[0] != nil {
				st := m.local.Slots[0].Status()
				peers, _ := st["mp_peers"].(float64)
				if peers >= 1 {
					m.radioSeen = true
				}
				if e, _ := st["mp_ended"].(string); e == "peer_lost" {
					alive = false
				}
				if m.radioSeen && peers < 1 {
					alive = false
				}
			}
			if !alive && m.state != MpReconnecting {
				m.prevState, m.reconnectSince = m.state, now
				m.go_(MpReconnecting)
				m.step = "Connessione persa. Riconnessione in corso…"
			} else if alive && m.state == MpReconnecting {
				m.go_(m.prevState)
				m.step = ""
				m.logf("peer back, resuming %s", m.prevState)
			} else if !alive && m.state == MpReconnecting && now.Sub(m.reconnectSince) > mpReconnectGrace*time.Millisecond {
				m.endLocked("peer_lost")
				m.players[1] = nil
				m.netDone = false
			}
		}
		m.mu.Unlock()
	}
}

// ReturnToLobby: "TORNA ALLA LOBBY" after a loss. Host: same room, waiting for a peer again. Guest: tries to join the same host lobby again.
func (m *MpSession) ReturnToLobby() *MpErr {
	m.mu.Lock()
	if m.state != MpEnded && m.state != MpError {
		m.mu.Unlock()
		return mpErr("not_ready")
	}
	if m.role == "host" && m.roomID != "" {
		m.teardownGameLocked()
		m.players[1] = nil
		m.net, m.netDone, m.err, m.step, m.plan = MpNetResult{}, false, nil, "", mpPlan{}
		m.hostDriverOK, m.guestDriverOK, m.radioSeen = false, false, false
		m.go_(MpIdle)
		m.go_(MpCreatingRoom)
		m.go_(MpWaitingForPeer)
		m.created = time.Now()
		if m.stopSuper == nil {
			m.stopSuper = make(chan struct{})
			go m.supervise(m.stopSuper)
		}
		m.mu.Unlock()
		return nil
	}
	last := m.lastJoin
	m.resetLocked()
	m.mu.Unlock()
	if last.Code == "" && last.Payload == "" && last.Room == "" && last.Addr == "" {
		return mpErr("peer_not_found")
	}
	return m.Join(last)
}
