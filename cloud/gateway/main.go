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
	Code    string
	Slots   [2]*Slot
	Tokens  [2]string
	Title   string
	SHA256  string
	Created time.Time
	Compat  bool // test-only "Multi-ROM compatibility mode": slot 2 also gets a cartridge
	peers   [2]*Peer
}

type Server struct {
	env  Env
	api  *webrtc.API
	ice  []webrtc.ICEServer
	mu   sync.Mutex
	room *Room
	up   websocket.Upgrader
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
	room.Tokens[0], room.Tokens[1] = randHex(8), randHex(8)
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
	if err := s.env.StartPulse([]string{"dslink_s1", "dslink_s2"}); err != nil {
		return err
	}
	// distinct deviceIds -> distinct DS MACs (DSLink DeviceIdentity); re-roll on the (unlikely) clash
	var d1, d2 string
	for i := 0; i < 8; i++ {
		d1, d2 = randHex(16), randHex(16)
		m1, _ := s.env.cfgtool("host", s.env.WorkDir, "", "", 56200, "Player1", d1, "mac")
		m2, _ := s.env.cfgtool("client", s.env.WorkDir, "", "127.0.0.1", 56200, "Player2", d2, "mac")
		if m1 != "" && m1 != m2 {
			break
		}
	}
	specs := [2]SlotSpec{
		{ID: 1, Display: ":101", Sink: "dslink_s1", Host: true, ROM: rom1, NetPort: 56200, VideoPort: 5004, AudioPort: 5006, Name: "Player1", DeviceID: d1},
		{ID: 2, Display: ":102", Sink: "dslink_s2", Host: false, ROM: rom2, NetPort: 56200, VideoPort: 5008, AudioPort: 5010, Name: "Player2", DeviceID: d2},
	}
	for i := range specs {
		sl := &Slot{Spec: specs[i], env: s.env}
		var err error
		if sl.Video, err = NewMediaIn(specs[i].VideoPort, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "video", fmt.Sprintf("slot%d", i+1)); err != nil {
			return err
		}
		if sl.Audio, err = NewMediaIn(specs[i].AudioPort, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", fmt.Sprintf("slot%d", i+1)); err != nil {
			return err
		}
		room.Slots[i] = sl
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
			sl.Video.Close()
			sl.Audio.Close()
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
		"slots": []any{s.room.Slots[0].Status(), s.room.Slots[1].Status()}, "peers": peers,
		"macs_differ":            s.room.Slots[0].ExpectedMAC != "" && s.room.Slots[0].ExpectedMAC != s.room.Slots[1].ExpectedMAC,
		"core_macs_match_dslink": (s.room.Slots[0].MAC == "" || s.room.Slots[0].MAC == s.room.Slots[0].ExpectedMAC) && (s.room.Slots[1].MAC == "" || s.room.Slots[1].MAC == s.room.Slots[1].ExpectedMAC),
	}})
}

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	web := flag.String("web", "../web", "static web UI directory")
	flag.Parse()
	env := Env{
		RetroArch:   getenv("DSLINK_RETROARCH", "/opt/dslink/bin/retroarch"),
		Core:        getenv("DSLINK_CORE", "/opt/dslink/lib/melondsds_libretro.so"),
		CfgTool:     getenv("DSLINK_CFGTOOL", "/opt/dslink/bin/dslink_cfgtool"),
		RomCheck:    getenv("DSLINK_ROMCHECK", "/opt/dslink/bin/dslink_romcheck"),
		FirmwareDir: os.Getenv("DSLINK_FIRMWARE_DIR"),
		WorkDir:     getenv("DSLINK_WORKDIR", "/tmp/dslink-cloud"),
		RuntimeDir:  getenv("XDG_RUNTIME_DIR", "/tmp/dslink-xdg"),
	}
	os.MkdirAll(env.WorkDir, 0o755)
	s := &Server{env: env, up: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}}
	if err := s.initWebRTC(); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
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
	mux.HandleFunc("/api/join", s.joinRoom)
	mux.HandleFunc("/api/status", s.status)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]any{"iceServers": s.ice})
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
	mux.Handle("/", http.FileServer(http.Dir(*web)))
	srv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
		<-c
		s.closeRoom()
		os.Exit(0)
	}()
	log.Printf("DSLink Cloud gateway on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
