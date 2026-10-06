// DSLink Cloud gateway: room lifecycle, ROM upload, WebRTC (pion) towards browsers, input injection.
// DS multiplayer packets never leave the container: the two emulators talk over loopback Netplay.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type Room struct {
	Code         string
	Slots        [3]*Slot // Hosted: [0] = the host's console, [1] and [2] = the consoles streamed to the (up to two) browser guests
	Tokens       [3]string
	Title        string
	SHA256       string
	Created      time.Time
	Solo         bool      // cloud solo session: only slot 1 runs
	FirmwareDirs [3]string // cloud sessions: each slot's own firmware
	ContentBase  string    // cloud sessions: where to persist saves
	Ticket       string
	Lan          *LanSpec // Distributed Mode: this device's single runtime is a LAN host/guest (no Unix-socket bridge, no second slot)
	Compat       bool     // test-only "Multi-ROM compatibility mode": slot 2 also gets a cartridge
	peers        [3]*Peer
}

type Server struct {
	env       Env
	api       *webrtc.API
	ice       []webrtc.ICEServer
	httpPort  int
	mp        *MpSession
	webg      webGuests // browsers on other devices (an iPhone) that play through this gateway: one guest session each, see mpweb.go
	udp       *mpUDP
	relayOnly bool // TURN-relay-only ICE policy (Cloudflare Containers: no inbound UDP)
	mu        sync.Mutex
	room      *Room
	up        websocket.Upgrader
}

// newTokens: one private token per console (the stream of console N can only be opened with token N)
func (r *Room) newTokens() {
	for i := range r.Tokens {
		r.Tokens[i] = randHex(8)
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func roomCode() string {
	const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	b := make([]byte, 5)
	rand.Read(b)
	for i := range b {
		b[i] = alpha[int(b[i])%len(alpha)]
	}
	return string(b)
}

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) saveUpload(r *http.Request, field, dst string) (bool, error) {
	f, _, err := r.FormFile(field)
	if err != nil {
		return false, nil
	}
	defer f.Close()
	out, err := os.Create(dst)
	if err != nil {
		return false, err
	}
	defer out.Close()
	_, err = io.Copy(out, f)
	return true, err
}

// POST /api/room  (multipart: rom [, rom2 for the test-only compatibility mode])
func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.room != nil {
		jsonOut(w, 409, map[string]string{"error": "una stanza è già attiva su questo container"})
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonOut(w, 400, map[string]string{"error": "form non valido"})
		return
	}
	dir := filepath.Join(s.env.WorkDir, "room")
	os.RemoveAll(dir)
	os.MkdirAll(dir, 0o755)
	if lan := lanSpecFromForm(r); lan != nil { // Distributed Mode (or auto): this device runs ONE runtime; only the emulated DS radio crosses the LAN
		s.createLanRoom(w, r, dir, lan)
		return
	}
	rom1 := filepath.Join(dir, "player1.nds")
	if ok, err := s.saveUpload(r, "rom", rom1); !ok || err != nil {
		jsonOut(w, 400, map[string]string{"error": "manca il file .nds"})
		return
	}
	info, err := run(s.env.RomCheck, rom1)
	kv := parseKV(info)
	if err != nil || kv["status"] != "OK" {
		os.RemoveAll(dir)
		msg := kv["message"]
		if msg == "" {
			msg = "ROM non valida"
		}
		jsonOut(w, 422, map[string]string{"error": msg})
		return
	}
	room := &Room{Code: roomCode(), Title: kv["title"], SHA256: kv["sha256"], Created: time.Now()}
	rom2 := ""
	if ok, _ := s.saveUpload(r, "rom2", filepath.Join(dir, "player2.nds")); ok {
		rom2 = filepath.Join(dir, "player2.nds")
		if k2 := parseKV(func() string { o, _ := run(s.env.RomCheck, rom2); return o }()); k2["status"] != "OK" {
			os.RemoveAll(dir)
			jsonOut(w, 422, map[string]string{"error": "rom2: " + k2["message"]})
			return
		}
		room.Compat = true
	}
	if err := s.startSlots(room, rom1, rom2); err != nil {
		log.Printf("room start failed: %v", err)
		for _, sl := range room.Slots {
			if sl != nil {
				sl.Stop()
			}
		}
		jsonOut(w, 500, map[string]string{"error": "impossibile avviare gli emulatori: " + err.Error()})
		return
	}
	room.newTokens()
	s.room = room
	jsonOut(w, 200, map[string]any{"code": room.Code, "player": 1, "token": room.Tokens[0], "title": room.Title})
}

func parseKV(s string) map[string]string {
	m := map[string]string{}
	for _, l := range strings.Split(s, "\n") {
		if i := strings.IndexByte(l, '='); i > 0 {
			m[l[:i]] = l[i+1:]
		}
	}
	return m
}

func (s *Server) startSlots(room *Room, rom1, rom2 string) error {
	return s.startSlotsN(room, rom1, []string{rom2})
}

// startSlotsN: the host's console + one console per guest (Hosted: up to two browser guests), all on ONE local DS wireless bridge.
func (s *Server) startSlotsN(room *Room, rom1 string, guestRoms []string) error {
	runtimeBackend := s.env.Backend != "retroarch"
	n := 1 + len(guestRoms)
	if n > len(room.Slots) {
		return fmt.Errorf("at most %d consoles", len(room.Slots))
	}
	if !runtimeBackend { // reference implementation (RetroArch + Xvfb + capture) needs PulseAudio sinks, two consoles at most
		if n > 2 {
			return fmt.Errorf("the RetroArch reference backend runs two consoles at most")
		}
		if err := s.env.StartPulse([]string{"dslink_s1", "dslink_s2"}); err != nil {
			return err
		}
	}
	// distinct deviceIds -> distinct DS MACs (DSLink DeviceIdentity); re-roll on the (unlikely) clash
	devs := make([]string, n)
	for try := 0; try < 8; try++ {
		macs := map[string]bool{}
		clash := false
		for i := 0; i < n; i++ {
			devs[i] = randHex(16)
			role, host := "client", "127.0.0.1"
			if i == 0 {
				role, host = "host", ""
			}
			m, _ := s.env.cfgtool(role, s.env.WorkDir, "", host, 56200, fmt.Sprintf("Player%d", i+1), devs[i], "mac")
			if m == "" || macs[m] {
				clash = true
			}
			macs[m] = true
		}
		if !clash {
			break
		}
	}
	specs := make([]SlotSpec, n)
	for i := 0; i < n; i++ {
		rom := rom1
		if i > 0 {
			rom = guestRoms[i-1]
		}
		specs[i] = SlotSpec{ID: i + 1, Display: fmt.Sprintf(":%d", 101+i), Sink: fmt.Sprintf("dslink_s%d", i+1), Host: i == 0, ROM: rom, NetPort: 56200, VideoPort: 5004 + 4*i, AudioPort: 5006 + 4*i,
			Name: fmt.Sprintf("Player%d", i+1), DeviceID: devs[i]}
	}
	for i := range specs {
		sl := &Slot{Spec: specs[i], env: s.env, FirmwareDir: room.FirmwareDirs[i]}
		sl.peerRttUs.Store(0)
		if runtimeBackend {
			sl.Backend = "runtime"
			v, err := newVideoTrack(fmt.Sprintf("slot%d", i+1))
			if err != nil {
				return err
			}
			a, err := newAudioTrack(fmt.Sprintf("slot%d", i+1))
			if err != nil {
				return err
			}
			sl.VideoTrack, sl.AudioTrack = v, a
		} else {
			sl.Backend = "retroarch"
			var err error
			if sl.Video, err = NewMediaIn(specs[i].VideoPort, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "video", fmt.Sprintf("slot%d", i+1)); err != nil {
				return err
			}
			if sl.Audio, err = NewMediaIn(specs[i].AudioPort, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", fmt.Sprintf("slot%d", i+1)); err != nil {
				return err
			}
			sl.VideoTrack, sl.AudioTrack = sl.Video.Track, sl.Audio.Track
		}
		room.Slots[i] = sl
	}
	if runtimeBackend {
		mp := filepath.Join(s.env.WorkDir, "mp.sock")
		if room.Lan != nil { // Distributed: this device runs one console only
			room.Slots[0].Lan = room.Lan
			room.Slots[0].Spec.Host = room.Lan.Role == "host"
			for i := 1; i < len(room.Slots); i++ {
				room.Slots[i] = nil
			}
		}
		if err := room.Slots[0].StartRuntime(mp); err != nil {
			return fmt.Errorf("slot 1: %w", err)
		}
		if room.Solo {
			return nil
		}
		time.Sleep(1500 * time.Millisecond) // the host's bridge listens as soon as its core is started
		for i := 1; i < n; i++ {
			if err := room.Slots[i].StartRuntime(mp); err != nil { // every guest console connects to the same bridge socket; the host numbers them 1, 2, ...
				return fmt.Errorf("slot %d: %w", i+1, err)
			}
			time.Sleep(700 * time.Millisecond)
		}
		return nil
	}
	if err := room.Slots[0].Start(); err != nil {
		return fmt.Errorf("slot 1: %w", err)
	}
	if !waitTCP("127.0.0.1:56200", 45*time.Second) {
		return fmt.Errorf("slot 1 Netplay host did not open its port")
	}
	if err := room.Slots[1].Start(); err != nil {
		return fmt.Errorf("slot 2: %w", err)
	}
	return nil
}

// POST /api/join {"code":"ABCDE"}
func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	var req struct{ Code string }
	json.NewDecoder(r.Body).Decode(&req)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.room == nil || !strings.EqualFold(s.room.Code, strings.TrimSpace(req.Code)) {
		jsonOut(w, 404, map[string]string{"error": "codice stanza non trovato"})
		return
	}
	if s.room.peers[1] != nil {
		jsonOut(w, 409, map[string]string{"error": "la stanza è piena"})
		return
	}
	jsonOut(w, 200, map[string]any{"code": s.room.Code, "player": 2, "token": s.room.Tokens[1], "title": s.room.Title})
}

func (s *Server) closeRoom() {
	s.mu.Lock()
	room := s.room
	s.room = nil
	s.mu.Unlock()
	if room == nil {
		return
	}
	for _, p := range room.peers {
		if p != nil {
			p.Close()
		}
	}
	for _, sl := range room.Slots {
		if sl != nil {
			sl.Stop()
			if sl.Video != nil {
				sl.Video.Close()
				sl.Audio.Close()
			}
		}
	}
	os.RemoveAll(filepath.Join(s.env.WorkDir, "room"))
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.room == nil {
		jsonOut(w, 200, map[string]any{"room": nil})
		return
	}
	peers := []int{}
	for i, p := range s.room.peers {
		if p != nil {
			peers = append(peers, i+1)
		}
	}
	jsonOut(w, 200, map[string]any{"room": map[string]any{
		"code": s.room.Code, "title": s.room.Title, "compat_mode": s.room.Compat,
		"slots": slotStatuses(s.room), "peers": peers,
		"macs_differ":            macsDiffer(s.room),
		"core_macs_match_dslink": (s.room.Slots[0].MAC == "" || s.room.Slots[0].MAC == s.room.Slots[0].ExpectedMAC) && (s.room.Slots[1] == nil || s.room.Slots[1].MAC == "" || s.room.Slots[1].MAC == s.room.Slots[1].ExpectedMAC),
		"session_mode":           sessionModeOf(s.room),
	}})
}

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	web := flag.String("web", "../web", "static web UI directory")
	controlsDir := flag.String("controls", "../worker/public/controls", "touch-controls module served at /controls/ (shared with the PWA)")
	flag.Parse()
	env := Env{
		RetroArch:     getenv("DSLINK_RETROARCH", "/opt/dslink/bin/retroarch"),
		Core:          getenv("DSLINK_CORE", "/opt/dslink/lib/melondsds_libretro.so"),
		CfgTool:       getenv("DSLINK_CFGTOOL", "/opt/dslink/bin/dslink_cfgtool"),
		RomCheck:      getenv("DSLINK_ROMCHECK", "/opt/dslink/bin/dslink_romcheck"),
		FirmwareDir:   os.Getenv("DSLINK_FIRMWARE_DIR"),
		WorkDir:       getenv("DSLINK_WORKDIR", "/tmp/dslink-cloud"),
		RuntimeDir:    getenv("XDG_RUNTIME_DIR", "/tmp/dslink-xdg"),
		Runtime:       getenv("DSLINK_RUNTIME", "/opt/dslink/bin/dslink-runtime"),
		Backend:       getenv("DSLINK_BACKEND", "runtime"),
		InternalToken: os.Getenv("DSLINK_INTERNAL_TOKEN"),
		ShmPath:       os.Getenv("DSLINK_SHM_PATH"),
		NoEncoder:     os.Getenv("DSLINK_NO_ENCODER") == "1",
		UILoopback:    os.Getenv("DSLINK_UI_LOOPBACK_ONLY") == "1",
		AdvertiseLAN:  os.Getenv("DSLINK_WEBRTC_ADVERTISE") == "1",
		TestHooks:     os.Getenv("DSLINK_TEST_HOOKS") == "1",
	}
	os.MkdirAll(env.WorkDir, 0o755)
	s := &Server{env: env, up: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}}
	if err := s.initWebRTC(); err != nil {
		log.Fatal(err)
	}
	s.initMp(*addr)
	mux := http.NewServeMux()
	s.registerMp(mux)
	mux.HandleFunc("/api/room", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			s.createRoom(w, r)
		case http.MethodDelete:
			s.closeRoom()
			jsonOut(w, 200, map[string]string{"ok": "closed"})
		default:
			http.Error(w, "method", 405)
		}
	})
	mux.HandleFunc("/api/internal/session", s.internalSession)
	mux.HandleFunc("/api/internal/end", s.internalEnd)
	mux.HandleFunc("/api/join", s.joinRoom)
	mux.HandleFunc("/api/status", s.status)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		cfg := map[string]any{"iceServers": s.ice}
		if s.relayOnly {
			cfg["iceTransportPolicy"] = "relay"
		}
		s.mu.Unlock()
		jsonOut(w, 200, cfg)
	})
	if os.Getenv("DSLINK_DEBUG") == "1" { // diagnostics only: last lines of a slot's RetroArch log
		mux.HandleFunc("/api/slotlog", func(w http.ResponseWriter, r *http.Request) {
			n, _ := strconv.Atoi(r.URL.Query().Get("slot"))
			s.mu.Lock()
			room := s.room
			s.mu.Unlock()
			if room == nil || n < 1 || n > 2 {
				http.Error(w, "no such slot", 404)
				return
			}
			b, _ := os.ReadFile(room.Slots[n-1].LogPath)
			if len(b) > 60000 {
				b = b[len(b)-60000:]
			}
			w.Header().Set("Content-Type", "text/plain")
			w.Write(b)
		})
	}
	mux.HandleFunc("/ws", s.ws)
	mux.Handle("/controls/", http.StripPrefix("/controls/", http.FileServer(http.Dir(*controlsDir))))
	files := http.FileServer(http.Dir(*web))
	mux.HandleFunc("/guest/", func(w http.ResponseWriter, r *http.Request) { // the web page of a browser guest (iPhone Safari / Home-Screen app): the multiplayer page in guest mode
		if r.URL.Path == "/guest/" {
			http.ServeFile(w, r, filepath.Join(*web, "mp", "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("/guest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/guest/?"+r.URL.RawQuery, http.StatusFound)
	})
	mux.Handle("/", files)
	srv := &http.Server{Addr: *addr, Handler: s.loopbackGuard(mux)}
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
		<-c
		s.closeRoom()
		os.Exit(0)
	}()
	if v := os.Getenv("DSLINK_PARENT_PID"); v != "" { // started by the Android app: if the app process dies, never linger as an orphan holding the port and the consoles
		pid, _ := strconv.Atoi(v)
		go func() {
			for range time.Tick(time.Second) {
				if pid > 0 && syscall.Kill(pid, 0) == syscall.ESRCH {
					s.closeRoom()
					os.Exit(0)
				}
			}
		}()
	}
	log.Printf("DSLink Cloud gateway on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// macsDiffer: every console of the room has its own DS MAC (and the host's is known)
func macsDiffer(r *Room) bool {
	seen := map[string]bool{}
	n := 0
	for _, sl := range r.Slots {
		if sl == nil {
			continue
		}
		n++
		if sl.ExpectedMAC == "" || seen[sl.ExpectedMAC] {
			return false
		}
		seen[sl.ExpectedMAC] = true
	}
	return n > 1
}
