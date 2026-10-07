package main

// SINGLE PLAYER: one DSLink Runtime + one melonDS, nothing else. No multiplayer room (no code, QR, secret, lobby, guests), no radio bridge, no WebRTC peer, no encoder
// (the console is drawn by the app from shared memory), no Download Play assistant, no screen references. Needs the ROM and the user's bios7/bios9/firmware.
// The game's save lives in a folder of its own, keyed by the library id (the ROM's hash), so it survives closing the app and is never shared with another game.

import (
	"path/filepath"
	"time"
)

const singleSaveEvery = 20 * time.Second // the Runtime also saves when it is closed; this covers the app being killed while playing

func (s *Server) saveDirFor(gameID string) string {
	return filepath.Join(s.libDir(), "saves", gameID)
}

func (m *MpSession) StartSingle(gameID string) *MpErr {
	m.mu.Lock()
	if m.web {
		m.mu.Unlock()
		return mpErr("busy")
	}
	if m.state != MpIdle && m.state != MpEnded && m.state != MpError {
		m.mu.Unlock()
		return mpErr("busy")
	}
	g, path, ok := m.srv.libGet(gameID)
	if !ok {
		m.mu.Unlock()
		return mpErr("no_game")
	}
	if m.srv.env.FirmwareDir != "" && !m.srv.env.TestHooks && !m.srv.firmwareOK() { // the app always points at the user's system files: all three must be there (no firmware folder, or the instrumented-test hooks = desktop/CI with the core's own BIOS)
		m.mu.Unlock()
		return mpErr("no_firmware")
	}
	m.resetLocked()
	m.role, m.game, m.gamePath, m.modeChosen, m.modeEffective = "host", g, path, "single", "single"
	m.hostName = deviceName()
	m.players[0] = &MpPlayer{Name: m.hostName, Role: "host", Connected: true, Ready: true}
	m.created = time.Now()
	m.solo, m.single = true, true
	for _, st := range []MpState{MpCreatingRoom, MpWaitingForPeer, MpConnected, MpReady, MpStarting} { // the state machine's own steps, all taken at once: nobody is in a room
		m.go_(st)
	}
	m.step = "Avvio Nintendo DS…"
	m.stopDrv = make(chan struct{})
	stop := m.stopDrv
	m.logf("SINGLE_PLAYER_START game=%s", g.ID)
	m.mu.Unlock()
	go func() {
		room := &Room{Code: roomCode(), Title: g.Title, Created: time.Now(), Solo: true, Single: true, SaveDir: m.srv.saveDirFor(g.ID)}
		if err := m.srv.startSlots(room, path, ""); err != nil {
			for _, sl := range room.Slots {
				if sl != nil {
					sl.Stop()
				}
			}
			m.failStart("start_failed", err)
			return
		}
		room.newTokens()
		m.mu.Lock()
		if m.stopDrv != stop { // left while it was starting
			m.mu.Unlock()
			room.Slots[0].Stop()
			return
		}
		m.srv.mu.Lock()
		m.srv.room = room
		m.srv.mu.Unlock()
		m.local = room
		m.go_(MpInGame)
		m.step = ""
		m.logf("SINGLE_PLAYER_RUNNING game=%s", g.ID)
		m.mu.Unlock()
		go func() { // periodic save while playing
			t := time.NewTicker(singleSaveEvery)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					if sl := room.Slots[0]; sl != nil && sl.rt != nil {
						sl.rt.send(lSave, nil)
					}
				}
			}
		}()
	}()
	return nil
}
