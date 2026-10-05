package main

import (
	"net"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// MediaIn receives RTP from ffmpeg on loopback and forwards it to a shared WebRTC track
// (every browser connected to this slot gets the same stream).
type MediaIn struct {
	conn  *net.UDPConn
	Track *webrtc.TrackLocalStaticRTP
	n     atomic.Uint64
	quit  chan struct{}
}

func NewMediaIn(port int, codec webrtc.RTPCodecCapability, id, stream string) (*MediaIn, error) {
	tr, err := webrtc.NewTrackLocalStaticRTP(codec, id, stream)
	if err != nil {
		return nil, err
	}
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		return nil, err
	}
	c.SetReadBuffer(1 << 20)
	m := &MediaIn{conn: c, Track: tr, quit: make(chan struct{})}
	go m.loop()
	return m, nil
}

func (m *MediaIn) loop() {
	buf := make([]byte, 1600)
	for {
		n, _, err := m.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		m.n.Add(1)
		m.Track.Write(buf[:n]) // errors (no peer yet) are expected
	}
}

func (m *MediaIn) Count() uint64 { return m.n.Load() }
func (m *MediaIn) Close()        { m.conn.Close() }
