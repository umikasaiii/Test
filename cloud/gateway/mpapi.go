package main

// HTTP surface of the multiplayer UX.
//   /api/mp/*     UI <-> this device's gateway (local)
//   /api/lobby/*  gateway <-> gateway on the LAN (the peer protocol)

import (
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log"
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
	go s.webGuestJanitor()
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
	if s.env.TestHooks {
		mux.HandleFunc("/api/mp/dev/solo", func(w http.ResponseWriter, r *http.Request) {
			var q struct{ GameID string }
			readBody(r, &q)
			mpReply(w, m.TestSolo(q.GameID), nil)
		})
	}
	mux.HandleFunc("/api/mp/net", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ IP, Broadcast string }
		readBody(r, &q)
		mpSetNet(q.IP, q.Broadcast)
		mpReply(w, nil, nil)
	})
	mux.HandleFunc("/api/mp/hints", func(w http.ResponseWriter, r *http.Request) { // the Android app's NSD/mDNS browse results: IPs of devices that advertise a DSLink room
		var q struct{ Addrs []string }
		readBody(r, &q)
		mpSetHints(q.Addrs)
		mpReply(w, nil, nil)
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
	mux.HandleFunc("/g/", s.handleWebGuest) // browser guests (iPhone): their own guest sessions, see mpweb.go
	// peer protocol
	mux.HandleFunc("/api/lobby/join", m.handleJoin)
	mux.HandleFunc("/api/lobby/status", m.handleLobbyStatus)
	mux.HandleFunc("/api/lobby/ready", m.handleLobbyReady)
	mux.HandleFunc("/api/lobby/net", m.handleLobbyNet)
	mux.HandleFunc("/api/lobby/report", m.handleLobbyReport)
	mux.HandleFunc("/api/lobby/leave", m.handleLobbyLeave)
}

// loopbackGuard: on the Android app the whole UI/control API (library, create, join, start, dev menu, static files) must only answer the app itself.
// guestStatic: the web files a browser guest needs (its page, the shared scripts and styles, the touch controls, icons). The host's own UI pages stay private.
func guestStatic(p string) bool {
	for _, pre := range []string{"/guest/", "/mp/vendor/", "/controls/", "/icons/"} {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}
	return p == "/mp/mp.js" || p == "/mp/mp.css"
}

// What other devices may reach: the peer lobby protocol (/api/lobby/*, authenticated by code/secret/token), the hosted stream signalling (/ws, token),
// a browser guest's own session (/g/<id>/..., see mpweb.go) and the static web files (the guest page, the touch controls: nothing private in them).
func (s *Server) loopbackGuard(next http.Handler) http.Handler {
	if !s.env.UILoopback {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/lobby/") || p == "/ws" || p == "/api/config" || strings.HasPrefix(p, "/g/") ||
			((r.Method == http.MethodGet || r.Method == http.MethodHead) && guestStatic(p)) {
			next.ServeHTTP(w, r)
			return
		}
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			log.Printf("refused %s %s from %s (not the app itself)", r.Method, r.URL.Path, r.RemoteAddr)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
