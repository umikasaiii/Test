package main

// Test hook for instrumented tests on ONE Android emulator (no second phone to play against): the library game is started as a Distributed host console
// with nobody else in the room, and the session goes straight to IN_GAME so the native display, audio, touch controls and lifecycle can be exercised.
// It exists only when DSLINK_TEST_HOOKS=1 (the app sets that only if the instrumentation creates the marker file before launching it).

import (
	"time"
)

func (m *MpSession) TestSolo(gameID string) *MpErr {
	m.mu.Lock()
	if m.state != MpIdle && m.state != MpEnded && m.state != MpError {
		m.mu.Unlock()
		return mpErr("busy")
	}
	g, path, ok := m.srv.libGet(gameID)
	if !ok {
		m.mu.Unlock()
		return mpErr("no_game")
	}
	m.resetLocked()
	m.role, m.game, m.gamePath, m.modeChosen, m.modeEffective = "host", g, path, "distributed", "distributed"
	m.roomID, m.code, m.secret = randHexN(4), randCode(), randHexN(16)
	m.hostName = deviceName()
	m.players[0] = &MpPlayer{Name: m.hostName, Role: "host", Connected: true, Ready: true}
	m.created = time.Now()
	m.solo = true
	for _, st := range []MpState{MpCreatingRoom, MpWaitingForPeer, MpConnected, MpReady, MpStarting} {
		m.go_(st)
	}
	m.plan = mpPlan{Mode: "distributed", Seq: 1, Attempt: 1}
	m.step = "Avvio Nintendo DS…"
	m.stopDrv = make(chan struct{})
	code, secret := m.code, m.secret
	m.mu.Unlock()
	go func() {
		room := &Room{Code: roomCode(), Title: g.Title, Created: time.Now(), Solo: true}
		room.Lan = &LanSpec{Role: "host", Code: code, Secret: secret, Advertise: advertiseIP(), Mode: "distributed"}
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
		m.srv.mu.Lock()
		m.srv.room = room
		m.srv.mu.Unlock()
		m.mu.Lock()
		m.local = room
		m.go_(MpInGame)
		m.step = ""
		m.mu.Unlock()
	}()
	return nil
}
