package main

// The multiplayer session of THIS device (host or guest): state machine, lobby, game start, supervision. The UI only ever reads /api/mp/state.
// No cloud: everything is LAN/local (HTTP between the two gateways for the lobby, UDP for discovery/netcheck, DSLink Radio Protocol or WebRTC for the game).

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MpPlayer struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Connected bool   `json:"connected"`
	Ready     bool   `json:"ready"`
	Pending   bool   `json:"pending"` // asked to join without code/QR: waits for the host's approval
	token     string
	lastSeen  time.Time
	addr      string
	dev       string
	roomSlot  int       // host side: the index of the console this guest plays on (1 or 2) once the game is launched
	goneSince time.Time // host side: since when its heartbeat is missing (zero = present)
	web       bool      // a browser (e.g. Safari on an iPhone) joined through this gateway's web guest page: it only ever plays Hosted (streamed console)
	lobbyOnly string    // the peer's own state as it reports it (guest -> host)
}

type mpPlan struct {
	Mode         string `json:"mode"` // distributed | hosted (empty until the host starts)
	LanPort      int    `json:"lanPort,omitempty"`
	HostedCode   string `json:"hostedCode,omitempty"`
	HostedToken  string `json:"hostedToken,omitempty"`  // filled per guest when it asks for the status: only its own console's token
	HostedPlayer int    `json:"hostedPlayer,omitempty"` // which console (2 or 3) is this guest's
	Seq          int    `json:"seq"`
	Attempt      int    `json:"attempt,omitempty"` // which try of the DS-level setup the host is on (the guest restarts its console when it grows)
}

const (
	mpPeerDeadMs      = 5000  // no heartbeat for this long = peer unreachable
	mpSetupAttempts   = 2     // the Download Play setup is redone once, quietly, before the user is told
	mpReconnectGrace  = 12000 // how long a vanished peer may come back before the session ends
	mpLobbyTTL        = 15 * time.Minute
	mpWebBrowserGrace = 5 * time.Second // a web guest whose browser has not asked anything for this long is treated as gone
)

type MpSession struct {
	mu  sync.Mutex
	srv *Server

	state MpState
	role  string // "host" | "guest" ("" when idle)

	roomID, code, secret string
	game                 LibGame
	gamePath             string
	modeChosen           string // auto | distributed | hosted (developer override; users get auto)
	modeEffective        string
	modeNote             string
	hostName             string
	devID                string       // random per gateway process, sent when joining
	solo                 bool         // test hook: a console with nobody else in the room (no supervision of a missing peer)
	attempt              int          // host: current try of the DS-level setup (1..mpSetupAttempts)
	guestAttempt         int          // guest: the host's attempt this device has acted on
	players              [3]*MpPlayer // [0] host, [1] and [2] guests (Hosted: up to two browser guests; Distributed: one)
	slot                 int          // guest side: the index the host gave this guest (1 = PLAYER 2, 2 = PLAYER 3)
	hostedGuests         int          // host side: consoles launched for guests in the current Hosted game
	guestDriversDone     int          // host side (Hosted): guests whose Download Play setup finished
	dlDone               map[int]bool // host side (Hosted): guests whose download completed (the host starts the game only after all of them)
	net                  MpNetResult
	netDone              bool
	step                 string
	err                  *MpErr
	created              time.Time
	plan                 mpPlan
	prevState            MpState
	reconnectSince       time.Time
	lockedUntil          time.Time
	badJoins             []time.Time
	devLog               []string

	// guest side
	hostAddr                    string // ip:port of the host gateway (HTTP)
	hostUDP                     int    // the host's discovery/echo UDP port
	hostIP                      string
	token                       string
	hostState                   MpState
	hostSeen                    time.Time
	started                     bool // guest: its own game launch has begun for the current plan
	lastJoin                    JoinRequest
	keepEnded                   bool
	radioSeen                   bool // host: the guest's radio link has been up at least once in this game
	hostDriverOK, guestDriverOK bool

	// web guest (a browser on another device that plays through THIS gateway, see mpweb.go): a guest session that lives inside the host's gateway
	web     bool
	webUA   string
	webSeen time.Time // the last request from the browser: a browser that went away (Safari in the background) stops the heartbeat the host watches

	// game
	stopSuper chan struct{}
	stopDrv   chan struct{}
	local     *Room // the runtime room of this device while a game runs
}

func newMpSession(s *Server) *MpSession {
	return &MpSession{srv: s, state: MpIdle, modeChosen: "auto", devID: randHexN(8)}
}

func (m *MpSession) logf(format string, a ...any) {
	line := time.Now().Format("15:04:05 ") + fmt.Sprintf(format, a...)
	m.devLog = append(m.devLog, line)
	if len(m.devLog) > 80 {
		m.devLog = m.devLog[len(m.devLog)-80:]
	}
	log.Printf("mp: %s", fmt.Sprintf(format, a...))
}

// go moves the state machine; illegal transitions are refused (and logged) instead of silently producing an impossible state.
func (m *MpSession) go_(to MpState) bool {
	if !mpCanGo(m.state, to) {
		m.logf("illegal transition %s -> %s refused", m.state, to)
		return false
	}
	if m.state != to {
		m.logf("%s -> %s", m.state, to)
	}
	m.state = to
	return true
}

func randHexN(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randCode() string {
	b := make([]byte, 4)
	rand.Read(b)
	v := 100000 + (uint32(b[0])<<24|uint32(b[1])<<16|uint32(b[2])<<8|uint32(b[3]))%900000
	return fmt.Sprintf("%06d", v)
}

func deviceName() string {
	if n := os.Getenv("DSLINK_DEVICE_NAME"); n != "" {
		return n
	}
	return "Giocatore " + fmt.Sprintf("%04d", 1000+int(randHexN(2)[0])*7%9000)
}

// advertiseIP is what goes inside the QR (never shown): first non-loopback IPv4, or DSLINK_ADVERTISE_IP.
// netOverride: the app (Android) tells the gateway which Wi-Fi address/broadcast to use and updates it when the network changes (a process cannot
// enumerate interfaces on modern Android: netlink is blocked, the platform's ConnectivityManager is the source of truth).
var netOverride struct {
	sync.Mutex
	ip, broadcast string
}

func mpSetNet(ip, broadcast string) {
	netOverride.Lock()
	defer netOverride.Unlock()
	netOverride.ip, netOverride.broadcast = "", ""
	if p := net.ParseIP(strings.TrimSpace(ip)); p != nil && p.To4() != nil {
		netOverride.ip = p.String()
	}
	if p := net.ParseIP(strings.TrimSpace(broadcast)); p != nil && p.To4() != nil {
		netOverride.broadcast = p.String()
	}
}

func advertiseIP() string {
	netOverride.Lock()
	ov := netOverride.ip
	netOverride.Unlock()
	if ov != "" {
		return ov
	}
	if v := os.Getenv("DSLINK_ADVERTISE_IP"); v != "" {
		return v
	}
	if ifs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range ifs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil {
				return ipn.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func (m *MpSession) qrPayload() string {
	if m.role != "host" || m.code == "" {
		return ""
	}
	// a plain web address: the iPhone's Camera app opens it in Safari (the guest page), the DSLink app on another phone reads the same parameters
	return fmt.Sprintf("http://%s:%d/guest/?c=%s&s=%s&r=%s&u=%d", advertiseIP(), m.srv.httpPort, m.code, m.secret, m.roomID, m.srv.udpPort())
}

// parseJoinPayload: the QR content, http://IP:PORT/guest/?c=CODE&s=SECRET&h=IP:PORT&r=ROOM&u=UDP (or the older dslink://join?... with the same parameters).
func parseJoinPayload(p string) (code, secret, host, room string, udp int, ok bool) {
	p = strings.TrimSpace(p)
	q := ""
	switch {
	case strings.HasPrefix(p, "dslink://join?"):
		q = p[len("dslink://join?"):]
	case strings.HasPrefix(p, "http://"):
		i := strings.Index(p, "/guest/?")
		if i < 0 {
			return
		}
		host = p[len("http://"):i] // the address the page was opened at is the host's
		q = p[i+len("/guest/?"):]
		if j := strings.IndexByte(q, '#'); j >= 0 {
			q = q[:j]
		}
	default:
		return
	}
	for _, kv := range strings.Split(q, "&") {
		i := strings.IndexByte(kv, '=')
		if i < 0 {
			continue
		}
		v := kv[i+1:]
		switch kv[:i] {
		case "c":
			code = v
		case "s":
			secret = v
		case "h":
			if host == "" {
				host = v
			}
		case "r":
			room = v
		case "u":
			udp, _ = strconv.Atoi(v)
		}
	}
	ok = len(code) == 6 && len(secret) == 32 && host != ""
	return
}

func netLabel(class string) (label, hint string) {
	switch class {
	case "GREEN":
		return "Ottima", ""
	case "YELLOW":
		return "Buona", "Per maggiore stabilità verrà utilizzata la modalità Hosted."
	case "RED":
		return "Non adatta", "Per maggiore stabilità verrà utilizzata la modalità Hosted."
	}
	return "In verifica…", ""
}

// ---------------------------------------------------------------- the one document the UI renders

func (m *MpSession) view(dev bool) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	pl := []map[string]any{}
	for i, p := range m.players {
		if p != nil {
			pl = append(pl, map[string]any{"name": p.Name, "role": p.Role, "connected": p.Connected, "ready": p.Ready, "pending": p.Pending, "slot": i})
		}
	}
	label, hint := netLabel(m.net.Class)
	if !m.netDone {
		label, hint = "In verifica…", ""
	}
	eff, modeNote := m.modeEffective, m.modeNote
	if eff == "" && m.netDone { // before START: what AUTOMATIC would pick right now (the host decides for real at START)
		eff, modeNote = m.decideMode()
	}
	modeLabel := "Automatica"
	switch eff {
	case "distributed":
		modeLabel = "Distribuita"
	case "hosted":
		modeLabel = "Hosted"
	}
	canStart := m.role == "host" && m.state == MpReady
	v := map[string]any{
		"state": m.state, "role": m.role, "game": map[string]any{"title": m.game.Title, "id": m.game.ID}, "code": m.code, "qr": m.qrPayload(), "hostName": m.hostName,
		"players": pl, "mode": map[string]any{"chosen": m.modeChosen, "effective": eff, "label": modeLabel, "note": modeNote},
		"net": map[string]any{"done": m.netDone, "class": m.net.Class, "label": label, "hint": hint}, "step": m.step, "error": m.err, "canStart": canStart,
		"expiresInSec": int((mpLobbyTTL - time.Since(m.created)).Seconds()),
		"you":          m.slot,
		"platform":     map[string]any{"native": m.srv.env.ShmPath != "" && !m.web, "hostedHost": !m.srv.env.NoEncoder, "web": m.web},
	}
	if (m.state == MpStarting || m.state == MpDownloadPlay || m.state == MpInGame || m.state == MpReconnecting) && m.local != nil {
		ig := map[string]any{"base": "", "code": m.local.Code, "player": 1, "token": m.local.Tokens[0]}
		if m.role == "guest" && m.plan.Mode == "hosted" {
			ig = map[string]any{"base": m.hostedBase(), "code": m.plan.HostedCode, "player": m.hostedPlayer(), "token": m.plan.HostedToken}
		}
		if m.srv.env.ShmPath != "" && ig["base"] == "" {
			ig["native"] = true // the console on this device is drawn by the app itself (shared memory), not streamed to the page
		}
		v["ingame"] = ig
	} else if m.role == "guest" && m.plan.Mode == "hosted" && (m.state == MpStarting || m.state == MpDownloadPlay || m.state == MpInGame || m.state == MpReconnecting) {
		v["ingame"] = map[string]any{"base": m.hostedBase(), "code": m.plan.HostedCode, "player": m.hostedPlayer(), "token": m.plan.HostedToken}
	}
	if dev {
		d := map[string]any{"net": m.net, "plan": m.plan, "log": m.devLog, "roomId": m.roomID, "hostAddr": m.hostAddr}
		if m.local != nil {
			sl := []any{}
			for _, s := range m.local.Slots {
				if s != nil {
					sl = append(sl, s.Status())
				}
			}
			d["slots"] = sl
		}
		v["dev"] = d
	}
	return v
}

func (m *MpSession) hostedPlayer() int {
	if m.plan.HostedPlayer >= 2 {
		return m.plan.HostedPlayer
	}
	return 2
}

// guestIdx lists the host-side guest positions that are filled (1, 2) in order
func (m *MpSession) guestIdx(connectedOnly bool) []int {
	var out []int
	for i := 1; i < len(m.players); i++ {
		if g := m.players[i]; g != nil && (!connectedOnly || (g.Connected && !g.Pending)) {
			out = append(out, i)
		}
	}
	return out
}

// hostedBase: where a Hosted guest's page opens the stream. A browser guest got its page FROM the host's gateway: same origin ("" = relative).
func (m *MpSession) hostedBase() string {
	if m.web {
		return ""
	}
	return "http://" + m.hostIP + ":" + hostPortOf(m.hostAddr)
}

func hostPortOf(addr string) string {
	if i := strings.LastIndexByte(addr, ':'); i >= 0 {
		return addr[i+1:]
	}
	return "8080"
}

// reset drops everything and goes back to IDLE (user left the multiplayer flow). Must be called with m.mu held.
func (m *MpSession) resetLocked() {
	if m.stopSuper != nil {
		close(m.stopSuper)
		m.stopSuper = nil
	}
	if m.stopDrv != nil {
		close(m.stopDrv)
		m.stopDrv = nil
	}
	m.teardownGameLocked()
	m.state, m.role = MpIdle, ""
	m.roomID, m.code, m.secret, m.token, m.hostAddr, m.hostIP = "", "", "", "", "", ""
	m.game, m.gamePath = LibGame{}, ""
	m.players = [3]*MpPlayer{}
	m.slot, m.hostedGuests, m.guestDriversDone, m.dlDone = 0, 0, 0, nil
	m.net, m.netDone, m.step, m.err = MpNetResult{}, false, "", nil
	m.modeEffective, m.modeNote, m.plan, m.started = "", "", mpPlan{}, false
	m.attempt, m.guestAttempt, m.solo = 0, 0, false
	m.hostState = ""
	m.hostDriverOK, m.guestDriverOK, m.radioSeen, m.keepEnded = false, false, false, false
	m.badJoins, m.lockedUntil = nil, time.Time{}
}

// teardownGameLocked stops this device's runtimes and frees the gateway room (sockets, processes, scratch files).
func (m *MpSession) teardownGameLocked() {
	if m.stopDrv != nil {
		close(m.stopDrv)
		m.stopDrv = nil
	}
	m.local = nil
	if m.web { // a web guest owns no console: the room belongs to the host session that lives in the same gateway
		return
	}
	m.srv.closeRoom() // stops the runtimes (process groups), closes the WebRTC peers, removes the scratch directory
}
