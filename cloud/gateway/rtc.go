package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// buildAPI: the WebRTC stack. natIP (optional) is the address advertised in the gateway's host candidates.
func buildAPI(natIP string) (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	if os.Getenv("DSLINK_LOOPBACK") == "1" {
		se.SetIncludeLoopbackCandidate(true) // local tests: browser and gateway on the same host
	}
	if ip := os.Getenv("DSLINK_PUBLIC_IP"); ip != "" {
		se.SetNAT1To1IPs([]string{ip}, webrtc.ICECandidateTypeHost)
	} else if natIP != "" {
		se.SetNAT1To1IPs([]string{natIP}, webrtc.ICECandidateTypeHost)
	}
	if lo, hi := os.Getenv("DSLINK_UDP_MIN"), os.Getenv("DSLINK_UDP_MAX"); lo != "" && hi != "" {
		a, _ := strconv.Atoi(lo)
		b, _ := strconv.Atoi(hi)
		se.SetEphemeralUDPPortRange(uint16(a), uint16(b))
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)), nil
}

func (s *Server) initWebRTC() error {
	api, err := buildAPI("")
	if err != nil {
		return err
	}
	s.api = api
	// ICE servers handed to browsers and used by the gateway: DSLINK_ICE='[{"urls":["stun:..."],"username":"","credential":""}]'
	// (a Cloudflare TURN adapter would fill this; see docs/CLOUD_MIGRATION.md - Cloudflare APIs are UNVERIFIED).
	if raw := os.Getenv("DSLINK_ICE"); raw != "" {
		json.Unmarshal([]byte(raw), &s.ice)
	}
	s.relayOnly = os.Getenv("DSLINK_RELAY_ONLY") == "1" // force the TURN-relay-only policy (local test of the Cloudflare Containers media path)
	return nil
}

// Peer is one browser connected to one slot.
type Peer struct {
	pc     *webrtc.PeerConnection
	slot   *Slot
	mu     sync.Mutex
	held   map[string]bool
	touch  bool
	closed bool
}

func (p *Peer) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	held := p.held
	touching := p.touch
	p.mu.Unlock()
	for k := range held { // never leave a button stuck after a disconnect
		p.slot.input.Button(k, false)
	}
	if touching {
		p.slot.input.Touch(0, 0, false, false)
	}
	p.pc.Close()
}

type inputMsg struct {
	T string  `json:"t"` // "btn" | "touch"
	K string  `json:"k"`
	D bool    `json:"d"`
	X float64 `json:"x"` // touch: 0..1 over the whole video frame
	Y float64 `json:"y"`
	M bool    `json:"m"` // move only
}

func (p *Peer) onInput(raw []byte) {
	p.slot.Events.Add(1)
	var m inputMsg
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	switch m.T {
	case "btn":
		p.mu.Lock()
		if m.D {
			p.held[m.K] = true
		} else {
			delete(p.held, m.K)
		}
		p.mu.Unlock()
		p.slot.input.Button(m.K, m.D)
	case "touch":
		p.mu.Lock()
		if !m.M {
			p.touch = m.D
		}
		down := m.D
		if m.M {
			down = p.touch // moves travel on the unordered channel and can overtake press/release: they never change the pressed state
		}
		p.mu.Unlock()
		p.slot.input.Touch(m.X, m.Y, down, m.M)
	}
}

type sigMsg struct {
	Type      string                   `json:"type"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

// GET /ws?code=..&player=1|2&token=..   signalling only; media and input then flow over WebRTC.
func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	player, _ := strconv.Atoi(q.Get("player"))
	s.mu.Lock()
	room := s.room
	ok := room != nil && strings.EqualFold(room.Code, q.Get("code")) && (player == 1 || player == 2) && room.Tokens[player-1] == q.Get("token")
	s.mu.Unlock()
	if !ok {
		log.Printf("ws refused: room=%v code=%q player=%d", room != nil, q.Get("code"), player)
		http.Error(w, "stanza o token non validi", http.StatusForbidden)
		return
	}
	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	slot := room.Slots[player-1]

	s.mu.Lock()
	cfg := webrtc.Configuration{ICEServers: s.ice}
	if s.relayOnly {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	s.mu.Unlock()
	api := s.api
	if s.env.AdvertiseLAN { // Android: the app tells the gateway its Wi-Fi/hotspot address (ConnectivityManager); native code cannot enumerate interfaces reliably
		if a, e := buildAPI(advertiseIP()); e == nil {
			api = a
		}
	}
	pc, err := api.NewPeerConnection(cfg)
	if err != nil {
		return
	}
	peer := &Peer{pc: pc, slot: slot, held: map[string]bool{}}
	var wmu sync.Mutex
	send := func(v any) { wmu.Lock(); conn.WriteJSON(v); wmu.Unlock() }

	// each browser only ever gets ITS slot's audio and video
	for _, t := range []webrtc.TrackLocal{slot.VideoTrack, slot.AudioTrack} {
		sender, err := pc.AddTrack(t)
		if err != nil {
			return
		}
		go func() { // RTCP: a browser asking for a picture refresh (PLI/FIR) gets a keyframe from the encoder
			for {
				pkts, _, err := sender.ReadRTCP()
				if err != nil {
					return
				}
				for _, p := range pkts {
					switch p.(type) {
					case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
						slot.RequestKeyframe()
					}
				}
			}
		}()
	}
	slot.RequestKeyframe()
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) { peer.onInput(msg.Data) })
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			j := c.ToJSON()
			send(sigMsg{Type: "candidate", Candidate: &j})
		}
	})
	var live atomic.Bool
	setLive := func(on bool) {
		if live.Swap(on) != on {
			if on {
				slot.peerLive.Add(1)
			} else {
				slot.peerLive.Add(-1)
			}
		}
	}
	defer setLive(false)
	statsStop := make(chan struct{})
	defer close(statsStop)
	go func() { // the developer overlay shows the round trip of the browser's WebRTC link
		for {
			select {
			case <-statsStop:
				return
			case <-time.After(2 * time.Second):
			}
			if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
				continue
			}
			for _, v := range pc.GetStats() {
				if cp, ok := v.(webrtc.ICECandidatePairStats); ok && cp.Nominated && cp.CurrentRoundTripTime > 0 {
					slot.peerRttUs.Store(int64(cp.CurrentRoundTripTime * 1e6))
				}
			}
		}
	}()
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("room %s player %d: %s", room.Code, player, st)
		setLive(st == webrtc.PeerConnectionStateConnected)
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed || st == webrtc.PeerConnectionStateDisconnected {
			peer.Close()
		}
	})
	s.mu.Lock()
	room.peers[player-1] = peer
	s.mu.Unlock()
	defer func() {
		peer.Close()
		s.mu.Lock()
		if room.peers[player-1] == peer {
			room.peers[player-1] = nil
		}
		s.mu.Unlock()
	}()

	for {
		var m sigMsg
		if err := conn.ReadJSON(&m); err != nil {
			return
		}
		switch m.Type {
		case "offer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
				log.Printf("offer: %v", err)
				return
			}
			ans, err := pc.CreateAnswer(nil)
			if err != nil {
				return
			}
			if err := pc.SetLocalDescription(ans); err != nil {
				return
			}
			send(sigMsg{Type: "answer", SDP: ans.SDP})
		case "candidate":
			if m.Candidate != nil {
				pc.AddICECandidate(*m.Candidate)
			}
		}
	}
}

var _ = net.IPv4
