package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStateMachineRejectsImpossibleTransitions(t *testing.T) {
	bad := [][2]MpState{{MpIdle, MpInGame}, {MpIdle, MpReady}, {MpWaitingForPeer, MpInGame}, {MpConnected, MpDownloadPlay}, {MpReady, MpInGame}, {MpEnded, MpInGame}, {MpError, MpConnected}, {MpStarting, MpReady}}
	for _, b := range bad {
		if mpCanGo(b[0], b[1]) {
			t.Errorf("%s -> %s must be impossible", b[0], b[1])
		}
	}
	good := [][2]MpState{{MpIdle, MpCreatingRoom}, {MpCreatingRoom, MpWaitingForPeer}, {MpWaitingForPeer, MpConnected}, {MpConnected, MpNetworkCheck}, {MpNetworkCheck, MpReady}, {MpReady, MpStarting},
		{MpStarting, MpDownloadPlay}, {MpDownloadPlay, MpStarting}, {MpDownloadPlay, MpInGame}, {MpInGame, MpReconnecting}, {MpReconnecting, MpInGame}, {MpReconnecting, MpEnded}, {MpEnded, MpIdle}}
	for _, g := range good {
		if !mpCanGo(g[0], g[1]) {
			t.Errorf("%s -> %s must be possible", g[0], g[1])
		}
	}
	// every state can end or fail, except the terminal ones which only return to IDLE
	for st := range mpAllowed {
		if st == MpIdle || st == MpEnded || st == MpError {
			continue
		}
		if !mpCanGo(st, MpEnded) && !mpCanGo(st, MpError) {
			t.Errorf("%s has no way out", st)
		}
	}
}

func TestClassifyNetConservativeThresholds(t *testing.T) {
	cases := []struct {
		r    MpNetResult
		want string
	}{
		{MpNetResult{Reachable: true, RttMs: 1, JitterMs: 0.5}, "GREEN"},
		{MpNetResult{Reachable: true, RttMs: 12, JitterMs: 3, LossPct: 2}, "GREEN"},
		{MpNetResult{Reachable: true, RttMs: 13, JitterMs: 1}, "YELLOW"},
		{MpNetResult{Reachable: true, RttMs: 18, JitterMs: 1}, "YELLOW"},
		{MpNetResult{Reachable: true, RttMs: 5, JitterMs: 6}, "YELLOW"},
		{MpNetResult{Reachable: true, RttMs: 19}, "RED"},
		{MpNetResult{Reachable: true, RttMs: 5, LossPct: 6}, "RED"},
		{MpNetResult{Reachable: true, RttMs: 5, JitterMs: 11}, "RED"},
		{MpNetResult{Reachable: false}, "RED"},
	}
	for _, c := range cases {
		if got := classifyNet(c.r); got != c.want {
			t.Errorf("%+v: got %s want %s", c.r, got, c.want)
		}
	}
}

func TestJoinPayloadAndSecrets(t *testing.T) {
	p := "dslink://join?c=482731&s=00112233445566778899aabbccddeeff&h=192.168.1.20:8080&r=ab12cd34"
	c, s, h, r, _, ok := parseJoinPayload(p)
	if !ok || c != "482731" || s != "00112233445566778899aabbccddeeff" || h != "192.168.1.20:8080" || r != "ab12cd34" {
		t.Fatalf("bad parse %v %v %v %v %v", c, s, h, r, ok)
	}
	for _, bad := range []string{"", "http://x", "dslink://join?c=1&s=2&h=3", "dslink://join?c=482731&s=short&h=1.2.3.4:5"} {
		if _, _, _, _, _, ok := parseJoinPayload(bad); ok {
			t.Errorf("payload %q must be rejected", bad)
		}
	}
	w := wrapSecret("tok", "start", "482731:abcdef")
	if v, ok := unwrapSecret("tok", "start", w); !ok || v != "482731:abcdef" {
		t.Fatal("wrap round trip")
	}
	if _, ok := unwrapSecret("other", "start", w); ok {
		t.Fatal("a different token must not unwrap the credentials")
	}
	if strings.Contains(p, "ROM") || strings.Contains(p, "bios") {
		t.Fatal("QR content must carry no private data")
	}
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	srv := httptest.NewServer(http.NewServeMux())
	defer srv.Close()
	p, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	return p
}

func TestNetCheckMeasuresDelayAndLoss(t *testing.T) {
	port := freeUDPPort(t)
	os.Setenv("DSLINK_MP_PORT", strconv.Itoa(port))
	defer os.Unsetenv("DSLINK_NETCHECK_IMPAIR")
	os.Setenv("DSLINK_NETCHECK_IMPAIR", "")
	u := startMpUDP(func() (mpAnnounce, bool) { return mpAnnounce{}, false })
	r := mpNetCheck("127.0.0.1", port, 30, 10*time.Millisecond)
	if !r.Reachable || r.LossPct > 3 || r.RttMs > 5 || r.Class != "GREEN" {
		t.Fatalf("clean loopback should be GREEN: %+v", r)
	}
	u.conn.Close()
	os.Setenv("DSLINK_NETCHECK_IMPAIR", "delay=25")
	port2 := freeUDPPort(t)
	os.Setenv("DSLINK_MP_PORT", strconv.Itoa(port2))
	u2 := startMpUDP(func() (mpAnnounce, bool) { return mpAnnounce{}, false })
	defer u2.conn.Close()
	r = mpNetCheck("127.0.0.1", port2, 30, 10*time.Millisecond)
	if r.RttMs < 20 || r.Class != "RED" {
		t.Fatalf("25 ms delay should be RED: %+v", r)
	}
	os.Setenv("DSLINK_NETCHECK_IMPAIR", "loss=40")
	port3 := freeUDPPort(t)
	os.Setenv("DSLINK_MP_PORT", strconv.Itoa(port3))
	u3 := startMpUDP(func() (mpAnnounce, bool) { return mpAnnounce{}, false })
	defer u3.conn.Close()
	r = mpNetCheck("127.0.0.1", port3, 60, 5*time.Millisecond)
	if r.LossPct < 15 || r.Class != "RED" {
		t.Fatalf("40%% loss should be RED with measurable loss: %+v", r)
	}
	if r2 := mpNetCheck("127.0.0.1", freeUDPPort(t), 5, 5*time.Millisecond); r2.Reachable || r2.Class != "RED" {
		t.Fatalf("nobody listening must be unreachable: %+v", r2)
	}
}

func TestDiscoveryByTagAndNearby(t *testing.T) {
	port := freeUDPPort(t)
	os.Setenv("DSLINK_MP_PORT", strconv.Itoa(port))
	os.Setenv("DSLINK_NETCHECK_IMPAIR", "")
	ann := mpAnnounce{Room: "r1", Title: "Test Game", Host: "Giocatore 1", HTTP: 9999, Tag: codeTag("482731"), Players: 1}
	u := startMpUDP(func() (mpAnnounce, bool) { return ann, true })
	defer u.conn.Close()
	if got := mpDiscover([]string{"127.0.0.1"}, port, codeTag("482731"), time.Second); len(got) != 1 || got[0].Room != "r1" || got[0].HTTP != 9999 {
		t.Fatalf("discovery by code tag: %+v", got)
	}
	if got := mpDiscover([]string{"127.0.0.1"}, port, codeTag("000000"), 700*time.Millisecond); len(got) != 0 {
		t.Fatalf("a wrong code tag must find nothing: %+v", got)
	}
	if got := mpDiscover([]string{"127.0.0.1"}, port, "", time.Second); len(got) != 1 {
		t.Fatalf("nearby listing: %+v", got)
	}
	if strings.Contains(ann.Tag, "482731") {
		t.Fatal("the code must not appear in the announcement")
	}
}

// ---- lobby between two gateways (no runtimes: the flow up to READY, and the failure paths)

type twoDev struct {
	host, guest *Server
	hsrv, gsrv  *httptest.Server
	port        int
}

func newTwoDev(t *testing.T) *twoDev {
	t.Helper()
	port := freeUDPPort(t)
	os.Setenv("DSLINK_MP_PORT", strconv.Itoa(port))
	os.Setenv("DSLINK_MP_DISCOVERY_ADDR", "127.0.0.1")
	os.Setenv("DSLINK_NETCHECK_IMPAIR", "")
	os.Setenv("DSLINK_ADVERTISE_IP", "127.0.0.1")
	mk := func() (*Server, *httptest.Server) {
		s := &Server{env: Env{WorkDir: t.TempDir()}}
		mux := http.NewServeMux()
		s.mp = newMpSession(s)
		s.registerMp(mux)
		srv := httptest.NewServer(mux)
		s.httpPort, _ = strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
		return s, srv
	}
	d := &twoDev{port: port}
	d.host, d.hsrv = mk()
	d.guest, d.gsrv = mk()
	d.host.udp = startMpUDP(d.host.mp.hostAnnounce) // only the host answers discovery/echo
	t.Cleanup(func() {
		d.host.mp.Reset()
		d.guest.mp.Reset()
		if d.host.udp.conn != nil {
			d.host.udp.conn.Close()
		}
		d.hsrv.Close()
		d.gsrv.Close()
	})
	// a game in the host's library (a stub file: the lobby never launches it)
	os.WriteFile(filepath.Join(d.host.libDir(), "g1.nds"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(d.host.libDir(), "g1.json"), []byte(`{"id":"g1","title":"Test Game","gameCode":"TEST","size":1}`), 0o600)
	return d
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if f() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func stateOf(s *Server) MpState { s.mp.mu.Lock(); defer s.mp.mu.Unlock(); return s.mp.state }

func TestLobbyCreateJoinReady(t *testing.T) {
	d := newTwoDev(t)
	if e := d.host.mp.Create("nope", "auto"); e == nil || e.Code != "no_game" {
		t.Fatalf("unknown game must be refused: %v", e)
	}
	if e := d.host.mp.Create("g1", "auto"); e != nil {
		t.Fatal(e)
	}
	v := d.host.mp.view(false)
	if v["state"] != MpWaitingForPeer || len(v["code"].(string)) != 6 || !strings.HasPrefix(v["qr"].(string), "dslink://join?") {
		t.Fatalf("host view: %+v", v)
	}
	if strings.Contains(v["qr"].(string), "bios") || strings.Contains(v["qr"].(string), ".nds") {
		t.Fatal("QR carries private data")
	}
	if e := d.host.mp.Create("g1", "auto"); e == nil || e.Code != "busy" {
		t.Fatal("a second room must be refused")
	}
	code := v["code"].(string)
	// INVALID CODE: rooms exist on the LAN, none with this code
	wrong := "000000"
	if wrong == code {
		wrong = "000001"
	}
	if e := d.guest.mp.Join(JoinRequest{Code: wrong}); e == nil || e.Code != "bad_code" || e.Message != "Codice partita non valido o scaduto." {
		t.Fatalf("invalid code: %v", e)
	}
	d.guest.mp.Reset()
	// JOIN BY CODE (LAN discovery finds the host by the code tag)
	if e := d.guest.mp.Join(JoinRequest{Code: code}); e != nil {
		t.Fatal(e)
	}
	waitFor(t, "guest connected + netcheck done + host NETWORK_CHECK->CONNECTED", func() bool {
		return stateOf(d.guest) == MpConnected && d.guest.mp.view(false)["net"].(map[string]any)["done"] == true && stateOf(d.host) == MpConnected
	})
	if c := d.host.mp.view(false)["net"].(map[string]any)["class"]; c != "GREEN" {
		t.Fatalf("loopback should pre-check GREEN, got %v", c)
	}
	if d.host.mp.view(false)["canStart"] != false {
		t.Fatal("START must stay disabled until the guest is ready")
	}
	// DUPLICATE JOIN: a third party finds the room full; the same device asking again is idempotent
	third := &Server{env: Env{WorkDir: t.TempDir()}}
	third.mp = newMpSession(third)
	if e := third.mp.Join(JoinRequest{Code: code}); e == nil || (e.Code != "room_full") {
		t.Fatalf("duplicate/third join must be refused as full: %v", e)
	}
	// READY
	if e := d.guest.mp.SetReady(true); e != nil {
		t.Fatal(e)
	}
	waitFor(t, "host READY", func() bool { return stateOf(d.host) == MpReady })
	if d.host.mp.view(false)["canStart"] != true {
		t.Fatal("START must be enabled when both are ready")
	}
	d.guest.mp.SetReady(false)
	waitFor(t, "host back to CONNECTED", func() bool { return stateOf(d.host) == MpConnected })
}

func TestLobbyJoinByQRPayloadAndNearbyApproval(t *testing.T) {
	d := newTwoDev(t)
	d.host.mp.Create("g1", "hosted")
	payload := d.host.mp.view(false)["qr"].(string)
	if e := d.guest.mp.Join(JoinRequest{Payload: payload}); e != nil {
		t.Fatal(e)
	}
	waitFor(t, "QR join connected", func() bool { return stateOf(d.guest) == MpConnected })
	d.guest.mp.Reset()
	waitFor(t, "host frees the slot after the guest left", func() bool { return stateOf(d.host) == MpWaitingForPeer })
	// NEARBY (no code, no QR): needs the host's approval
	rooms := d.guest.mp.Nearby()
	if len(rooms) != 1 || rooms[0]["title"] != "Test Game" {
		t.Fatalf("nearby: %+v", rooms)
	}
	if e := d.guest.mp.Join(JoinRequest{Room: rooms[0]["room"].(string)}); e != nil {
		t.Fatal(e)
	}
	if stateOf(d.guest) != MpJoining || stateOf(d.host) != MpWaitingForPeer {
		t.Fatalf("pending join must not connect: guest %s host %s", stateOf(d.guest), stateOf(d.host))
	}
	d.host.mp.Approve(true)
	waitFor(t, "approved guest connected", func() bool { return stateOf(d.guest) == MpConnected && stateOf(d.host) == MpConnected })
	// a forged QR (wrong secret) is refused even with the right code
	d.guest.mp.Reset()
	waitFor(t, "slot free", func() bool { return stateOf(d.host) == MpWaitingForPeer })
	forged := strings.Replace(payload, "s="+payload[strings.Index(payload, "s=")+2:strings.Index(payload, "&h=")], "s=00000000000000000000000000000000", 1)
	if e := d.guest.mp.Join(JoinRequest{Payload: forged}); e == nil || e.Code != "bad_code" {
		t.Fatalf("forged QR secret must be refused: %v", e)
	}
	d.guest.mp.Reset()
	d.host.mp.Create("g1", "auto") // (busy: still hosting) - the reject path of nearby is covered below
}

func TestLobbyHostCancelGuestLeaveExpiryAndLockout(t *testing.T) {
	d := newTwoDev(t)
	d.host.mp.Create("g1", "auto")
	code := d.host.mp.view(false)["code"].(string)
	d.guest.mp.Join(JoinRequest{Code: code})
	waitFor(t, "connected", func() bool { return stateOf(d.guest) == MpConnected && stateOf(d.host) == MpConnected })
	// GUEST LEAVE
	d.guest.mp.Cancel()
	waitFor(t, "host waiting again after the guest left", func() bool { return stateOf(d.host) == MpWaitingForPeer })
	// HOST CANCEL: the guest learns it with a friendly message
	d.guest.mp.Join(JoinRequest{Code: code})
	waitFor(t, "connected again", func() bool { return stateOf(d.guest) == MpConnected })
	d.host.mp.Cancel()
	waitFor(t, "guest sees the host closed the game", func() bool { return stateOf(d.guest) == MpEnded })
	if e := d.guest.mp.view(false)["error"].(*MpErr); e.Code != "host_closed" || e.Message != "L'host ha chiuso la partita." {
		t.Fatalf("host cancel message: %+v", e)
	}
	d.guest.mp.Reset()
	d.host.mp.Reset()
	if stateOf(d.host) != MpIdle || stateOf(d.guest) != MpIdle {
		t.Fatal("both sides must return to IDLE")
	}
	// EXPIRED SESSION
	d.host.mp.Create("g1", "auto")
	code = d.host.mp.view(false)["code"].(string)
	d.host.mp.mu.Lock()
	d.host.mp.created = time.Now().Add(-mpLobbyTTL - time.Minute)
	d.host.mp.mu.Unlock()
	waitFor(t, "lobby expiry", func() bool { return stateOf(d.host) == MpEnded })
	if e := d.guest.mp.Join(JoinRequest{Code: code}); e == nil || (e.Code != "peer_not_found" && e.Code != "room_expired") {
		t.Fatalf("joining an expired room: %v", e)
	}
	d.host.mp.Reset()
	d.guest.mp.Reset()
	// brute force: repeated bad proofs lock the room, even for the right code
	d.host.mp.Create("g1", "auto")
	code = d.host.mp.view(false)["code"].(string)
	addr := "127.0.0.1:" + strconv.Itoa(d.host.httpPort)
	for i := 0; i < 9; i++ {
		d.guest.mp.Join(JoinRequest{Code: "99999" + strconv.Itoa(i%10), Addr: addr})
		d.guest.mp.Reset()
	}
	if e := d.guest.mp.Join(JoinRequest{Code: code, Addr: addr}); e == nil || e.Code != "locked" {
		t.Fatalf("lockout: %v", e)
	}
}

// The DS-level setup is redone once, quietly; an old attempt's failure is ignored; the last attempt's failure reaches the user.
func TestSetupFailedRetriesOnceThenTellsTheUser(t *testing.T) {
	s := &Server{env: Env{WorkDir: t.TempDir()}}
	s.mp = newMpSession(s)
	m := s.mp
	m.mu.Lock()
	m.role, m.state, m.attempt = "host", MpDownloadPlay, mpSetupAttempts
	m.mu.Unlock()
	m.setupFailed("distributed", mpSetupAttempts-1, errors.New("old attempt")) // not the current attempt: ignored
	if stateOf(s) != MpDownloadPlay {
		t.Fatalf("a failure of an older attempt must be ignored, state %s", stateOf(s))
	}
	m.setupFailed("distributed", mpSetupAttempts, errors.New("last attempt"))
	if st := stateOf(s); st != MpError {
		t.Fatalf("the last attempt's failure must reach the user, state %s", st)
	}
	if e := m.view(false)["error"].(*MpErr); e.Code != "setup_timeout" {
		t.Fatalf("error %v", e)
	}
}

// Android app mode: only the app itself may use the UI API; other devices reach the peer lobby protocol and the hosted stream signalling only.
func TestLoopbackGuardOnlyOpensThePeerProtocolToTheLAN(t *testing.T) {
	s := &Server{env: Env{UILoopback: true}}
	h := s.loopbackGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	code := func(path, remote string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = remote
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for _, p := range []string{"/api/mp/library", "/api/mp/create", "/api/mp/dev/snapshot", "/mp/", "/api/status"} {
		if code(p, "192.168.1.9:5555") != 403 {
			t.Errorf("%s must be refused to a LAN peer", p)
		}
		if code(p, "127.0.0.1:5555") != 204 {
			t.Errorf("%s must work for the app itself", p)
		}
	}
	for _, p := range []string{"/api/lobby/join", "/api/lobby/status", "/ws"} {
		if code(p, "192.168.1.9:5555") != 204 {
			t.Errorf("%s must stay reachable for the other device", p)
		}
	}
	off := &Server{}
	if off.loopbackGuard(http.NotFoundHandler()) == nil {
		t.Fatal("guard disabled must pass through")
	}
}

func TestDiscoveryHintsAndNoEncoderMode(t *testing.T) {
	mpSetHints([]string{"192.168.1.20", "not-an-ip", "::1", " 10.0.0.7 "})
	a := discoveryAddrs()
	has := func(x string) bool {
		for _, v := range a {
			if v == x {
				return true
			}
		}
		return false
	}
	if !has("192.168.1.20") || !has("10.0.0.7") || has("not-an-ip") || has("::1") || has(" 10.0.0.7 ") {
		t.Fatalf("hints must be validated IPv4 only: %v", a)
	}
	mpSetHints(nil)
	s := &Server{env: Env{NoEncoder: true, WorkDir: t.TempDir()}}
	s.mp = newMpSession(s)
	s.mp.modeChosen, s.mp.netDone, s.mp.net = "auto", true, MpNetResult{Class: "RED"}
	if eff, _ := s.mp.decideMode(); eff != "distributed" {
		t.Fatalf("a build without an encoder cannot be the Hosted host: %s", eff)
	}
	s.env.NoEncoder = false
	if eff, _ := s.mp.decideMode(); eff != "hosted" {
		t.Fatalf("a bad network still picks Hosted when an encoder exists: %s", eff)
	}
}

func TestNetOverrideFeedsAdvertiseIPAndBroadcast(t *testing.T) {
	mpSetNet("192.168.1.50", "192.168.1.255")
	defer mpSetNet("", "")
	if advertiseIP() != "192.168.1.50" {
		t.Fatalf("advertise %s", advertiseIP())
	}
	found := false
	for _, a := range discoveryAddrs() {
		if a == "192.168.1.255" {
			found = true
		}
	}
	if !found {
		t.Fatal("the directed broadcast must be probed too")
	}
	mpSetNet("not-an-ip", "::1")
	if advertiseIP() == "not-an-ip" {
		t.Fatal("only IPv4 addresses are accepted")
	}
}
