package main

// Web guests: a browser on another device (the iPhone's Safari / the Home-Screen web app) plays through THIS gateway. The consoles (Hosted mode: both
// Nintendo DS emulators, the Download Play link between them) stay on the host device; the browser receives video/audio over WebRTC and sends buttons/touch back.
//
// Every browser gets its own guest session inside the host's gateway (a normal MpSession with web=true that speaks the same lobby protocol to the host session
// over loopback). So the browser never sees an address, a port, a token or any crypto: it asks for the room by CODE (or the QR the host shows) and renders the
// same /api/mp/state document as every other screen. The only difference is the URL prefix /g/<id>/ that selects its session.

import (
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

type webGuest struct {
	m   *MpSession
	mux *http.ServeMux
}

type webGuests struct {
	mu   sync.Mutex
	byID map[string]*webGuest
}

const maxWebGuests = 4

var sidRe = regexp.MustCompile(`^[0-9a-f]{16,64}$`)

// webDeviceName: what the host's lobby calls the browser guest
func webDeviceName(ua string) string {
	switch {
	case strings.Contains(ua, "iPhone"):
		return "iPhone"
	case strings.Contains(ua, "iPad"):
		return "iPad"
	case strings.Contains(ua, "Android"):
		return "Android (browser)"
	}
	return "Browser"
}

func lobbyOpen(st MpState) bool {
	return st == MpWaitingForPeer || st == MpConnected || st == MpNetworkCheck || st == MpReady
}

// resolveLocalHost: the host session of this gateway as the target of a web guest's join.
func (m *MpSession) resolveLocalHost(req JoinRequest) (code, secret, hostAddr, room, via string, udp int, e *MpErr) {
	h := m.srv.mp
	h.mu.Lock()
	room, st := h.roomID, h.state
	isHost := h.role == "host"
	h.mu.Unlock()
	if h == m || !isHost || room == "" || !lobbyOpen(st) {
		log.Printf("mp: ROOM_NOT_FOUND endpoint=/g/<sid>/api/mp/join room_requested=%q host_room=%q host_state=%s host=%v", req.Room, room, st, isHost)
		e = mpErr("peer_not_found")
		return
	}
	switch {
	case req.Payload != "":
		c, s, _, r, _, ok := parseJoinPayload(req.Payload)
		if !ok {
			e = mpErr("bad_code")
			return
		}
		if r != "" && r != room {
			e = mpErr("room_expired")
			return
		}
		code, secret, via = c, s, "qr"
	case len(req.Code) == 6:
		code, via = req.Code, "code"
	default:
		e = mpErr("bad_code")
		return
	}
	hostAddr = "127.0.0.1:" + itoa(m.srv.httpPort)
	udp = m.srv.udpPort()
	return
}

func (s *Server) webGuestFor(sid, ua string) *webGuest {
	s.webg.mu.Lock()
	defer s.webg.mu.Unlock()
	if s.webg.byID == nil {
		s.webg.byID = map[string]*webGuest{}
	}
	if wg := s.webg.byID[sid]; wg != nil {
		return wg
	}
	if len(s.webg.byID) >= maxWebGuests { // make room by dropping a session whose browser has gone quiet
		for id, w := range s.webg.byID {
			w.m.mu.Lock()
			idle := time.Since(w.m.webSeen) > 20*time.Second
			w.m.mu.Unlock()
			if idle {
				go w.m.Reset()
				delete(s.webg.byID, id)
				break
			}
		}
		if len(s.webg.byID) >= maxWebGuests {
			return nil
		}
	}
	m := newMpSession(s)
	m.web, m.webUA, m.webSeen = true, ua, time.Now()
	log.Printf("mp: SESSION_ID web guest session %s… created", sid[:6])
	wg := &webGuest{m: m, mux: http.NewServeMux()}
	wg.mux.HandleFunc("/api/mp/state", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, 200, m.view(false)) })
	wg.mux.HandleFunc("/api/mp/join", func(w http.ResponseWriter, r *http.Request) {
		var q JoinRequest
		readBody(r, &q)
		q.Room, q.Addr = "", "" // a browser guest never picks an address
		mpReply(w, m.Join(q), nil)
	})
	wg.mux.HandleFunc("/api/mp/ready", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Ready bool }
		readBody(r, &q)
		mpReply(w, m.SetReady(q.Ready), nil)
	})
	wg.mux.HandleFunc("/api/mp/cancel", func(w http.ResponseWriter, r *http.Request) { m.Cancel(); mpReply(w, nil, nil) })
	wg.mux.HandleFunc("/api/mp/reset", func(w http.ResponseWriter, r *http.Request) { m.Reset(); mpReply(w, nil, nil) })
	wg.mux.HandleFunc("/api/mp/lobby-return", func(w http.ResponseWriter, r *http.Request) { mpReply(w, m.ReturnToLobby(), nil) })
	s.webg.byID[sid] = wg
	return wg
}

// /g/<sid>/api/mp/<op>: reachable from the LAN (see loopbackGuard); <sid> is chosen by the browser and is its only credential for its own guest session.
func (s *Server) handleWebGuest(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/g/")
	i := strings.IndexByte(rest, '/')
	if i < 0 || !sidRe.MatchString(rest[:i]) {
		http.NotFound(w, r)
		return
	}
	wg := s.webGuestFor(rest[:i], r.UserAgent())
	if wg == nil {
		http.Error(w, "too many guests", http.StatusServiceUnavailable)
		return
	}
	wg.m.mu.Lock()
	wg.m.webSeen = time.Now()
	wg.m.mu.Unlock()
	r2 := r.Clone(r.Context())
	r2.URL.Path = rest[i:]
	wg.mux.ServeHTTP(w, r2)
}

// webGuestJanitor: sessions of browsers that never came back are released (the host is told they left).
func (s *Server) webGuestJanitor() {
	for range time.Tick(10 * time.Second) {
		s.webg.mu.Lock()
		for id, w := range s.webg.byID {
			w.m.mu.Lock()
			gone := time.Since(w.m.webSeen) > 90*time.Second
			w.m.mu.Unlock()
			if gone {
				go w.m.Reset()
				delete(s.webg.byID, id)
			}
		}
		s.webg.mu.Unlock()
	}
}
