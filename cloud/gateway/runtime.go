package main

// Production backend: DSLink Runtime (minimal libretro host + melonDS DS + in-process H.264/Opus encoder).
// One process per emulator slot. The gateway only forwards encoded samples to WebRTC and browser input to the runtime.
// DS multiplayer packets travel between runtimes over a Unix socket inside the container (the Multiplayer Bridge).

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	lVideo, lAudio, lLog, lStatus                                   = 1, 2, 3, 4
	lButton, lTouch, lSnapshot, lQuit, lKeyframe, lAudioDump, lSave = 10, 11, 12, 13, 14, 15, 16
)

// libretro RetroPad ids
var padID = map[string]byte{"b": 0, "y": 1, "select": 2, "start": 3, "up": 4, "down": 5, "left": 6, "right": 7, "a": 8, "x": 9, "l": 10, "r": 11, "l2": 12, "r2": 13}

// DSLINK_VIDEO_CODEC=h264 (default, production) or vp8 (browsers without WebRTC H.264)
func videoCodec() string {
	if os.Getenv("DSLINK_VIDEO_CODEC") == "vp8" {
		return "vp8"
	}
	return "h264"
}

type RuntimeLink struct {
	conn   net.Conn
	wmu    sync.Mutex
	mu     sync.Mutex
	status map[string]any
	mac    string
	mp     bool // the core logged "Starting multiplayer on libretro side"
	video  *webrtc.TrackLocalStaticSample
	audio  *webrtc.TrackLocalStaticSample
	logs   []string
	closed bool
}

var (
	reMPstart = regexp.MustCompile(`Starting multiplayer on libretro side`)
	reCoreMAC = regexp.MustCompile(`\[melonDS\] MAC: ([0-9A-F:]{17})`)
)

func newVideoTrack(stream string) (*webrtc.TrackLocalStaticSample, error) {
	if videoCodec() == "vp8" {
		return webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "video", stream)
	}
	return webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, "video", stream)
}

func newAudioTrack(stream string) (*webrtc.TrackLocalStaticSample, error) {
	return webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", stream)
}

func (l *RuntimeLink) send(t byte, payload []byte) {
	l.wmu.Lock()
	defer l.wmu.Unlock()
	if l.conn == nil {
		return
	}
	h := make([]byte, 8)
	h[0] = t
	binary.LittleEndian.PutUint32(h[4:], uint32(len(payload)))
	l.conn.Write(append(h, payload...))
}

func (l *RuntimeLink) read() {
	hdr := make([]byte, 8)
	var lastV uint64
	for {
		if _, err := io.ReadFull(l.conn, hdr); err != nil {
			l.mu.Lock()
			l.closed = true
			l.mu.Unlock()
			return
		}
		n := binary.LittleEndian.Uint32(hdr[4:])
		if n > 8<<20 {
			return
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(l.conn, p); err != nil {
			return
		}
		switch hdr[0] {
		case lVideo:
			if len(p) > 8 {
				pts := binary.LittleEndian.Uint64(p)
				d := time.Second / 60
				if lastV != 0 && pts > lastV {
					d = time.Duration(pts-lastV) * time.Microsecond
				}
				lastV = pts
				l.video.WriteSample(media.Sample{Data: p[8:], Duration: d})
			}
		case lAudio:
			if len(p) > 8 {
				pts := binary.LittleEndian.Uint64(p)
				_ = pts
				l.audio.WriteSample(media.Sample{Data: p[8:], Duration: 20 * time.Millisecond})
			}
		case lStatus:
			var m map[string]any
			if json.Unmarshal(p, &m) == nil {
				l.mu.Lock()
				l.status = m
				l.mu.Unlock()
			}
		case lLog:
			s := string(p)
			l.mu.Lock()
			if reMPstart.MatchString(s) {
				l.mp = true
			}
			if m := reCoreMAC.FindStringSubmatch(s); m != nil {
				l.mac = m[1]
			}
			l.logs = append(l.logs, s)
			if len(l.logs) > 400 {
				l.logs = l.logs[len(l.logs)-400:]
			}
			l.mu.Unlock()
		}
	}
}

func (l *RuntimeLink) Stats() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]any{"runtime_link_open": !l.closed, "mac": l.mac, "core_multiplayer": l.mp}
	for _, k := range []string{"frames", "fps", "mp_active", "mp_peers", "mp_role", "mp_in", "mp_out", "video_frames", "audio_packets", "slowest_frame_ms", "width", "height", "dl_state", "dl_counters", "dl_hist", "session_mode", "radio", "stream", "lan", "lan_code", "lan_join_uri", "lan_port", "mp_ended"} {
		if v, ok := l.status[k]; ok {
			out[k] = v
		}
	}
	return out
}

func (l *RuntimeLink) Logs() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.logs, "\n")
}

// SlotInput
func (l *RuntimeLink) Button(name string, down bool) {
	id, ok := padID[name]
	if !ok {
		return
	}
	d := byte(0)
	if down {
		d = 1
	}
	l.send(lButton, []byte{0, id, d})
}

func (l *RuntimeLink) Touch(x, y float64, down bool, move bool) {
	b := make([]byte, 9)
	binary.LittleEndian.PutUint32(b, math.Float32bits(float32(x)))
	binary.LittleEndian.PutUint32(b[4:], math.Float32bits(float32(y)))
	if down {
		b[8] = 1
	}
	l.send(lTouch, b)
}

func (l *RuntimeLink) Close() { l.send(lQuit, nil) }

func (s *Slot) RequestKeyframe() {
	if s.rt != nil {
		s.rt.send(lKeyframe, nil)
	}
}

// StartRuntime brings the slot up with the DSLink Runtime (no RetroArch, no X, no screen capture).
func (s *Slot) StartRuntime(mpPath string) error {
	env := s.env
	s.dir = filepath.Join(env.WorkDir, fmt.Sprintf("slot%d", s.Spec.ID))
	for _, d := range []string{"system/melonDS DS", "saves", "config"} {
		os.MkdirAll(filepath.Join(s.dir, d), 0o755)
	}
	fwDir := env.FirmwareDir
	if s.FirmwareDir != "" { // cloud sessions: this slot's OWN firmware, streamed from the owner's private storage
		fwDir = s.FirmwareDir
	}
	if fwDir != "" { // private firmware: copied per slot at runtime, never in the image or repo
		for _, f := range []string{"bios7.bin", "bios9.bin", "firmware.bin"} {
			if b, err := os.ReadFile(filepath.Join(fwDir, f)); err == nil {
				os.WriteFile(filepath.Join(s.dir, "system/melonDS DS", f), b, 0o600)
			}
		}
	}
	role, hostip := "client", "127.0.0.1"
	if s.Spec.Host {
		role, hostip = "host", ""
	}
	opts, err := env.cfgtool(role, s.dir, s.Spec.ROM, hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "opts")
	if err != nil {
		return fmt.Errorf("cfgtool opts: %v", err)
	}
	optPath := filepath.Join(s.dir, "config", "melondsds.opt")
	os.WriteFile(optPath, []byte(opts+"melonds_show_cursor = \"disabled\"\n"), 0o644)
	s.Nick, _ = env.cfgtool(role, s.dir, "", hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "nick")
	s.ExpectedMAC, _ = env.cfgtool(role, s.dir, "", hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "mac")

	s.LogPath = filepath.Join(s.dir, "runtime.log")
	logf, err := os.Create(s.LogPath)
	if err != nil {
		return err
	}
	sock := filepath.Join(s.dir, "link.sock")
	os.Remove(sock) // a killed previous console leaves its socket file behind: never mistake it for the new one
	args := []string{"--core", env.Core, "--system", filepath.Join(s.dir, "system"), "--save", filepath.Join(s.dir, "saves"),
		"--options", optPath, "--username", s.Nick, "--link", sock, "--av", "on", "--codec", videoCodec(), "--name", fmt.Sprintf("slot%d", s.Spec.ID),
		"--log", s.LogPath}
	if s.Lan != nil { // Distributed Mode: the emulated DS radio goes over the LAN transport; no Unix-socket bridge exists for this slot
		args = append(args, s.Lan.runtimeArgs()...)
	} else {
		args = append(args, "--mp-path", mpPath)
		if s.Spec.Host {
			args = append(args, "--mp-role", "host")
		} else {
			args = append(args, "--mp-role", "client", "--mp-timeout", "60000")
		}
	}
	if s.Spec.ROM != "" {
		args = append(args, "--content", s.Spec.ROM)
	}
	cmd, err := s.spawn(logf, nil, env.Runtime, args...)
	if err != nil {
		return err
	}
	reap(cmd)
	if !waitFile(sock, 15*time.Second) {
		return fmt.Errorf("runtime %d did not open its link", s.Spec.ID)
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return err
	}
	link := &RuntimeLink{conn: conn, video: s.VideoTrack.(*webrtc.TrackLocalStaticSample), audio: s.AudioTrack.(*webrtc.TrackLocalStaticSample)}
	s.rt = link
	s.input = link
	go link.read()
	return nil
}
