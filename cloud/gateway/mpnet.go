package main

// LAN discovery and network pre-check for the multiplayer lobby. Three concerns stay separate (docs/MULTIPLAYER_UX.md):
//   DISCOVERY    UDP broadcast "who hosts a room here?" -> ANNOUNCE (room id, title, host label, HTTP port). Nothing secret.
//   SESSION AUTH HTTP join with an HMAC proof of the code / QR secret (mplobby.go)
//   GAME TRANSPORT the DSLink Radio Protocol (runtime) or WebRTC (hosted)
// The same UDP port answers echo probes: the guest sends a burst of timestamped datagrams and measures RTT, jitter, loss and reachability.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/rand"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mpAnnounce struct {
	T       string `json:"t"`
	Room    string `json:"room"`
	Title   string `json:"title"`
	Host    string `json:"host"`
	HTTP    int    `json:"http"`
	UDP     int    `json:"udp"` // this host's discovery/echo port (tests run several devices on one machine)
	Tag     string `json:"tag,omitempty"`
	Players int    `json:"players"`
	Addr    string `json:"-"` // filled by the receiver: the sender's IP
}

type mpImpair struct{ delay, jitter, loss float64 }

func parseImpair(s string) mpImpair {
	var im mpImpair
	for _, kv := range strings.Split(s, ",") {
		p := strings.SplitN(kv, "=", 2)
		if len(p) != 2 {
			continue
		}
		v, _ := strconv.ParseFloat(p[1], 64)
		switch p[0] {
		case "delay":
			im.delay = v
		case "jitter":
			im.jitter = v
		case "loss":
			im.loss = v
		}
	}
	return im
}

func (im mpImpair) active() bool { return im.delay > 0 || im.jitter > 0 || im.loss > 0 }

// codeTag is what a guest looks for when it knows the code: a keyed hash, so the broadcast never carries the code itself.
func codeTag(code string) string {
	m := hmac.New(sha256.New, []byte("dslink-discovery-v1"))
	m.Write([]byte(code))
	return hex.EncodeToString(m.Sum(nil))[:16]
}

type mpUDP struct {
	conn    *net.UDPConn
	port    int
	impair  mpImpair
	mu      sync.Mutex
	hosting func() (mpAnnounce, bool) // returns the current room announcement when this device hosts a joinable room
}

func mpPort() int {
	if v, err := strconv.Atoi(os.Getenv("DSLINK_MP_PORT")); err == nil && v > 0 {
		return v
	}
	return 47532
}

func startMpUDP(hosting func() (mpAnnounce, bool)) *mpUDP {
	u := &mpUDP{port: mpPort(), hosting: hosting, impair: parseImpair(os.Getenv("DSLINK_NETCHECK_IMPAIR"))}
	c, err := net.ListenUDP("udp4", &net.UDPAddr{Port: u.port})
	if err != nil {
		return u // discovery unavailable (port taken): joining by QR/code with a known address still works
	}
	u.conn = c
	go u.loop()
	return u
}

func (u *mpUDP) loop() {
	buf := make([]byte, 1024)
	for {
		n, from, err := u.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(buf[:n], &m) != nil {
			continue
		}
		switch m["t"] {
		case "echo":
			data := append([]byte(nil), buf[:n]...)
			u.reply(data, from)
		case "disc":
			ann, ok := u.hosting()
			if !ok {
				continue
			}
			if tag, _ := m["tag"].(string); tag != "" && tag != ann.Tag {
				continue
			}
			ann.T = "ann"
			b, _ := json.Marshal(ann)
			u.reply(b, from)
		}
	}
}

func (u *mpUDP) reply(b []byte, to *net.UDPAddr) {
	if u.impair.active() {
		if u.impair.loss > 0 && rand.Float64()*100 < u.impair.loss {
			return
		}
		d := u.impair.delay + (rand.Float64()*2-1)*u.impair.jitter
		if d > 0.05 {
			go func() { time.Sleep(time.Duration(d * float64(time.Millisecond))); u.conn.WriteToUDP(b, to) }()
			return
		}
	}
	u.conn.WriteToUDP(b, to)
}

// mpDiscover asks the LAN for rooms. addrs: where to send (broadcast by default; tests add 127.0.0.1). tag: only rooms with that code tag ("" = every room).
func mpDiscover(addrs []string, port int, tag string, window time.Duration) []mpAnnounce {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return nil
	}
	defer c.Close()
	q, _ := json.Marshal(map[string]string{"t": "disc", "tag": tag})
	send := func() {
		for _, a := range addrs {
			host, p := a, strconv.Itoa(port)
			if h, pp, err := net.SplitHostPort(a); err == nil { // "ip:port" entries (several devices on one machine in tests)
				host, p = h, pp
			}
			if ua, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, p)); err == nil {
				c.WriteToUDP(q, ua)
			}
		}
	}
	send()
	seen := map[string]mpAnnounce{}
	end := time.Now().Add(window)
	next := time.Now().Add(250 * time.Millisecond)
	buf := make([]byte, 2048)
	for time.Now().Before(end) {
		c.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		n, from, err := c.ReadFromUDP(buf)
		if time.Now().After(next) {
			send()
			next = time.Now().Add(250 * time.Millisecond)
		}
		if err != nil {
			continue
		}
		var a mpAnnounce
		if json.Unmarshal(buf[:n], &a) == nil && a.T == "ann" && a.Room != "" {
			a.Addr = from.IP.String()
			seen[a.Room] = a
		}
	}
	out := make([]mpAnnounce, 0, len(seen))
	for _, a := range seen {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Room < out[j].Room })
	return out
}

type MpNetResult struct {
	Samples   int     `json:"samples"`
	Received  int     `json:"received"`
	RttMs     float64 `json:"rttMs"`    // median
	JitterMs  float64 `json:"jitterMs"` // mean absolute difference between consecutive RTTs
	LossPct   float64 `json:"lossPct"`
	Reachable bool    `json:"reachable"`
	Class     string  `json:"class"` // GREEN | YELLOW | RED
}

// classifyNet: CONSERVATIVE V1 desktop criteria (to be recalibrated on phones). The measured stable limit of Distributed was ~16 ms RTT.
func classifyNet(r MpNetResult) string {
	switch {
	case !r.Reachable || r.RttMs > 18 || r.LossPct > 5 || r.JitterMs > 10:
		return "RED"
	case r.RttMs <= 12 && r.JitterMs <= 4 && r.LossPct <= 2:
		return "GREEN"
	default:
		return "YELLOW"
	}
}

// mpNetCheck sends n timestamped probes to host:port and evaluates the replies (several samples, never a single ping).
func mpNetCheck(host string, port, n int, spacing time.Duration) MpNetResult {
	res := MpNetResult{Samples: n}
	ua, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		res.Class = "RED"
		return res
	}
	c, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		res.Class = "RED"
		return res
	}
	defer c.Close()
	sent := make([]time.Time, n)
	rtts := make([]float64, n)
	got := make([]bool, n)
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 512)
		for {
			c.SetReadDeadline(time.Now().Add(time.Duration(n)*spacing + 600*time.Millisecond))
			k, _, err := c.ReadFromUDP(buf)
			if err != nil {
				close(done)
				return
			}
			var m struct {
				T   string `json:"t"`
				Seq int    `json:"seq"`
			}
			if json.Unmarshal(buf[:k], &m) == nil && m.T == "echo" && m.Seq >= 0 && m.Seq < n && !got[m.Seq] {
				rtts[m.Seq] = float64(time.Since(sent[m.Seq]).Microseconds()) / 1000
				got[m.Seq] = true
			}
		}
	}()
	for i := 0; i < n; i++ {
		sent[i] = time.Now()
		b, _ := json.Marshal(map[string]any{"t": "echo", "seq": i})
		c.WriteToUDP(b, ua)
		time.Sleep(spacing)
	}
	time.Sleep(450 * time.Millisecond)
	c.SetReadDeadline(time.Now())
	<-done
	var ok []float64
	var seq []float64
	for i := 0; i < n; i++ {
		if got[i] {
			ok = append(ok, rtts[i])
			seq = append(seq, rtts[i])
		}
	}
	res.Received = len(ok)
	res.Reachable = len(ok) > 0
	res.LossPct = 100 * float64(n-len(ok)) / float64(n)
	if len(ok) > 0 {
		sort.Float64s(ok)
		res.RttMs = ok[len(ok)/2]
		var sum float64
		for i := 1; i < len(seq); i++ {
			sum += math.Abs(seq[i] - seq[i-1])
		}
		if len(seq) > 1 {
			res.JitterMs = sum / float64(len(seq)-1)
		}
	}
	res.Class = classifyNet(res)
	return res
}
