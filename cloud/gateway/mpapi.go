package main

// HTTP surface of the multiplayer UX.
//   /api/mp/*     UI <-> this device's gateway (local)
//   /api/lobby/*  gateway <-> gateway on the LAN (the peer protocol)

import (
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func (s *Server) initMp(addr string) {
	if i := strings.LastIndexByte(addr, ':'); i >= 0 {
		s.httpPort, _ = strconv.Atoi(addr[i+1:])
	}
	s.mp = newMpSession(s)
	s.udp = startMpUDP(s.mp.hostAnnounce)
}

func (s *Server) udpPort() int {
	if s.udp != nil && s.udp.conn != nil {
		return s.udp.port
	}
	return mpPort()
}

func readBody(r *http.Request, v any) {
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(v)
}

func mpReply(w http.ResponseWriter, e *MpErr, ok map[string]any) {
	if e != nil {
		jsonOut(w, 400, map[string]any{"error": e})
		return
	}
	if ok == nil {
		ok = map[string]any{"ok": true}
	}
	jsonOut(w, 200, ok)
}

func (s *Server) registerMp(mux *http.ServeMux) {
	m := s.mp
	mux.HandleFunc("/api/mp/state", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, 200, m.view(r.URL.Query().Get("dev") == "1")) })
	mux.HandleFunc("/api/mp/library", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			s.libAdd(w, r)
			return
		}
		jsonOut(w, 200, map[string]any{"games": s.libList()})
	})
	mux.HandleFunc("/api/mp/library/delete", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ ID string }
		readBody(r, &q)
		jsonOut(w, 200, map[string]any{"ok": s.libDelete(q.ID)})
	})
	mux.HandleFunc("/api/mp/create", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ GameID, Mode string }
		readBody(r, &q)
		mpReply(w, m.Create(q.GameID, q.Mode), nil)
	})
	mux.HandleFunc("/api/mp/nearby", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, 200, map[string]any{"rooms": m.Nearby()}) })
	mux.HandleFunc("/api/mp/join", func(w http.ResponseWriter, r *http.Request) {
		var q JoinRequest
		readBody(r, &q)
		mpReply(w, m.Join(q), nil)
	})
	mux.HandleFunc("/api/mp/ready", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Ready bool }
		readBody(r, &q)
		mpReply(w, m.SetReady(q.Ready), nil)
	})
	mux.HandleFunc("/api/mp/approve", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Accept bool }
		readBody(r, &q)
		m.Approve(q.Accept)
		mpReply(w, nil, nil)
	})
	mux.HandleFunc("/api/mp/start", func(w http.ResponseWriter, r *http.Request) { mpReply(w, m.Start(), nil) })
	mux.HandleFunc("/api/mp/cancel", func(w http.ResponseWriter, r *http.Request) { m.Cancel(); mpReply(w, nil, nil) })
	mux.HandleFunc("/api/mp/reset", func(w http.ResponseWriter, r *http.Request) { m.Reset(); mpReply(w, nil, nil) })
	mux.HandleFunc("/api/mp/lobby-return", func(w http.ResponseWriter, r *http.Request) { mpReply(w, m.ReturnToLobby(), nil) })
	mux.HandleFunc("/api/mp/dev/mode", func(w http.ResponseWriter, r *http.Request) { // developer menu: Automatico | Distributed | Hosted (before create)
		var q struct{ Mode string }
		readBody(r, &q)
		m.mu.Lock()
		if q.Mode == "auto" || q.Mode == "distributed" || q.Mode == "hosted" {
			m.modeChosen = q.Mode
		}
		m.mu.Unlock()
		mpReply(w, nil, nil)
	})
	mux.HandleFunc("/api/mp/dev/snapshot", func(w http.ResponseWriter, r *http.Request) { // developer only: this device's console picture, loopback requests only
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if os.Getenv("DSLINK_DEV") != "1" || (host != "127.0.0.1" && host != "::1") {
			http.NotFound(w, r)
			return
		}
		m.mu.Lock()
		room := m.local
		m.mu.Unlock()
		idx, _ := strconv.Atoi(r.URL.Query().Get("slot"))
		if room == nil || idx < 0 || idx > 1 || room.Slots[idx] == nil {
			http.NotFound(w, r)
			return
		}
		d := &dlDriver{slot: room.Slots[idx], stop: make(chan struct{})}
		wd, ht, px, err := d.capture()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		img := image.NewRGBA(image.Rect(0, 0, wd, ht))
		for i := 0; i < wd*ht; i++ {
			img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = px[i*3], px[i*3+1], px[i*3+2], 255
		}
		w.Header().Set("Content-Type", "image/png")
		png.Encode(w, img)
	})
	// peer protocol
	mux.HandleFunc("/api/lobby/join", m.handleJoin)
	mux.HandleFunc("/api/lobby/status", m.handleLobbyStatus)
	mux.HandleFunc("/api/lobby/ready", m.handleLobbyReady)
	mux.HandleFunc("/api/lobby/net", m.handleLobbyNet)
	mux.HandleFunc("/api/lobby/report", m.handleLobbyReport)
	mux.HandleFunc("/api/lobby/leave", m.handleLobbyLeave)
}
