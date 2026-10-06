package main

import (
	"bufio"
	"fmt"
	"github.com/pion/webrtc/v4"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Env describes where the container's tools live (all overridable for tests).
type Env struct {
	RetroArch     string // patched RetroArch with X11 + GL + Pulse
	Core          string // melondsds_libretro.so
	CfgTool       string // dslink_cfgtool (C++ DSLink layer: identity, MAC, RetroArch config)
	RomCheck      string // dslink_romcheck
	InternalToken string // shared secret with the Worker (enables /api/internal/*)
	FirmwareDir   string // optional: directory with the user's bios7.bin / bios9.bin / firmware.bin (private)
	WorkDir       string
	RuntimeDir    string // XDG_RUNTIME_DIR for PulseAudio
	Runtime       string // dslink-runtime (production backend)
	Backend       string // "runtime" (default) or "retroarch" (reference implementation)
	// Android app (local front end): the console shown on THIS device writes raw frames/audio into a shared-memory file that the app renders natively
	// (no encoder, no WebRTC for the local player), takes buttons/touch from the same file, and the UI API answers loopback requests only.
	ShmPath      string // DSLINK_SHM_PATH
	NoEncoder    bool   // DSLINK_NO_ENCODER=1: this build has no H.264/VP8/Opus encoder, so it cannot stream a console to another device (Hosted host)
	TestHooks    bool   // DSLINK_TEST_HOOKS=1: instrumented-test endpoints (see mptest_hooks.go)
	AdvertiseLAN bool   // DSLINK_WEBRTC_ADVERTISE=1: WebRTC host candidates advertise the LAN address the platform reported (advertiseIP)
	UILoopback   bool   // DSLINK_UI_LOOPBACK_ONLY=1: everything except the peer lobby protocol and the hosted stream answers loopback only
}

const (
	screenW = 512
	screenH = 768
)

// SlotSpec is one emulator instance: its own X display, audio sink, identity, media ports and Netplay role.
type SlotSpec struct {
	ID        int
	Display   string // ":101"
	Sink      string // PulseAudio null sink
	Host      bool   // slot 1 hosts Netplay, slot 2 connects (Download Play client)
	ROM       string // empty = boot with NO cartridge (Download Play client)
	NetPort   int
	VideoPort int
	AudioPort int
	Name      string
	DeviceID  string
}

type Slot struct {
	FirmwareDir string // per-slot override of Env.FirmwareDir (cloud sessions)
	Spec        SlotSpec
	env         Env
	dir         string
	mu          sync.Mutex
	procs       []*exec.Cmd
	Nick        string
	MAC         string // as reported by the core (empty if it stopped before printing it)
	ExpectedMAC string // DSLink DeviceIdentity derivation of the nickname given to RetroArch
	Joined      bool   // Netplay link established (RetroArch log)
	CoreMP      bool   // core reported "Starting multiplayer"
	LogPath     string
	Video       *MediaIn
	Audio       *MediaIn
	input       SlotInput
	Backend     string // "runtime" (production) or "retroarch" (reference)
	VideoTrack  webrtc.TrackLocal
	AudioTrack  webrtc.TrackLocal
	rt          *RuntimeLink
	Lan         *LanSpec      // Distributed Mode: LAN RadioTransport instead of the in-process bridge
	Events      atomic.Uint64 // input messages received from the browser
	peerRttUs   atomic.Int64  // the browser's WebRTC round trip (ICE candidate pair), microseconds; 0 = not measured yet
	peerLive    atomic.Int32  // browsers currently connected to this slot's stream
}

var (
	reJoined = regexp.MustCompile(`has joined as player 2|You have joined as player 2`)
	reMP     = regexp.MustCompile(`Starting multiplayer on libretro side`)
	reMAC    = regexp.MustCompile(`\[melonDS\] MAC: ([0-9A-F:]{17})`)
)

func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (e Env) cfgtool(role, dir, rom, hostip string, port int, name, dev, what string) (string, error) {
	r := rom
	if r == "" {
		r = "-"
	}
	h := hostip
	if h == "" {
		h = "-"
	}
	return run(e.CfgTool, role, dir, e.Core, r, h, fmt.Sprint(port), name, dev, what)
}

// StartPulse makes sure PulseAudio runs and every slot sink exists (idempotent).
func (e Env) StartPulse(sinks []string) error {
	os.MkdirAll(e.RuntimeDir, 0o700)
	os.Setenv("XDG_RUNTIME_DIR", e.RuntimeDir)
	if _, err := run("pactl", "info"); err != nil {
		if out, err := run("pulseaudio", "--start", "--exit-idle-time=-1", "--disallow-exit", "--log-target=stderr"); err != nil {
			return fmt.Errorf("pulseaudio: %v: %s", err, out)
		}
		for i := 0; i < 50; i++ {
			if _, err := run("pactl", "info"); err == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	existing, _ := run("pactl", "list", "short", "sinks")
	for _, s := range sinks {
		if strings.Contains(existing, s) {
			continue
		}
		if out, err := run("pactl", "load-module", "module-null-sink", "sink_name="+s); err != nil {
			return fmt.Errorf("null sink %s: %v: %s", s, err, out)
		}
	}
	return nil
}

func (s *Slot) spawn(logf *os.File, extraEnv []string, name string, args ...string) (*exec.Cmd, error) {
	c := exec.Command(name, args...)
	c.Env = append(os.Environ(), extraEnv...)
	c.Stdout, c.Stderr = logf, logf
	c.SysProcAttr = sysProcAttr()
	if err := c.Start(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.procs = append(s.procs, c)
	s.mu.Unlock()
	return c, nil
}

func waitFile(path string, d time.Duration) bool {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func waitTCP(addr string, d time.Duration) bool {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
			c.Close()
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// Start brings the slot up: Xvfb -> RetroArch(+melonDS DS) -> capture (video+audio) -> input injector.
func (s *Slot) Start() error {
	env := s.env
	s.dir = filepath.Join(env.WorkDir, fmt.Sprintf("slot%d", s.Spec.ID))
	for _, d := range []string{"system/melonDS DS", "saves", "states", "config"} {
		os.MkdirAll(filepath.Join(s.dir, d), 0o755)
	}
	// private firmware (never in the image or repo): copied per slot when present
	if env.FirmwareDir != "" {
		for _, f := range []string{"bios7.bin", "bios9.bin", "firmware.bin"} {
			if b, err := os.ReadFile(filepath.Join(env.FirmwareDir, f)); err == nil {
				os.WriteFile(filepath.Join(s.dir, "system/melonDS DS", f), b, 0o600)
			}
		}
	}
	role, hostip := "client", "127.0.0.1" // Netplay never leaves the container
	if s.Spec.Host {
		role, hostip = "host", ""
	}
	cfg, err := env.cfgtool(role, s.dir, s.Spec.ROM, hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "cfg")
	if err != nil {
		return fmt.Errorf("cfgtool cfg: %v: %s", err, cfg)
	}
	opts, err := env.cfgtool(role, s.dir, s.Spec.ROM, hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "opts")
	if err != nil {
		return fmt.Errorf("cfgtool opts: %v", err)
	}
	s.Nick, _ = env.cfgtool(role, s.dir, "", hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "nick")
	s.ExpectedMAC, _ = env.cfgtool(role, s.dir, "", hostip, s.Spec.NetPort, s.Spec.Name, s.Spec.DeviceID, "mac")
	// cloud overrides: X11 + software GL, windowed 1:1 so the browser's touch maps exactly onto the bottom screen,
	// Pulse sink per slot, absolute X pointer (no mouse grab), no cursor drawing, JIT left to the core default.
	cfg += `video_driver = "gl"
audio_driver = "pulse"
input_driver = "x"
video_fullscreen = "false"
video_scale = "2.0"
video_scale_integer = "true"
video_window_show_decorations = "false"
video_window_auto_width_max = "512"
video_window_auto_height_max = "768"
input_auto_mouse_grab = "false"
menu_driver = "rgui"
notification_show_when_menu_is_alive = "false"
video_font_enable = "false"
`
	os.WriteFile(filepath.Join(s.dir, "retroarch.cfg"), []byte(cfg), 0o644)
	os.WriteFile(filepath.Join(s.dir, "config", "melondsds.opt"), []byte(opts+`melonds_show_cursor = "disabled"
`), 0o644)

	s.LogPath = filepath.Join(s.dir, "retroarch.log")
	logf, err := os.Create(s.LogPath)
	if err != nil {
		return err
	}

	sock := "/tmp/.X11-unix/X" + strings.TrimPrefix(s.Spec.Display, ":")
	os.Remove(sock)
	if _, err := s.spawn(logf, nil, "Xvfb", s.Spec.Display, "-screen", "0", fmt.Sprintf("%dx%dx24", screenW, screenH), "-nolisten", "tcp"); err != nil {
		return err
	}
	if !waitFile(sock, 10*time.Second) {
		return fmt.Errorf("Xvfb %s did not start", s.Spec.Display)
	}

	args := []string{"-v", "-c", filepath.Join(s.dir, "retroarch.cfg"), "-L", env.Core}
	if s.Spec.Host {
		args = append(args, "-H")
	} else {
		args = append(args, "-C", "127.0.0.1")
	}
	args = append(args, "--port", fmt.Sprint(s.Spec.NetPort), "--nick", s.Nick)
	if s.Spec.ROM != "" {
		args = append(args, s.Spec.ROM)
	}
	renv := []string{"DISPLAY=" + s.Spec.Display, "PULSE_SINK=" + s.Spec.Sink, "XDG_RUNTIME_DIR=" + env.RuntimeDir, "HOME=" + s.dir}
	if _, err := s.spawn(logf, renv, env.RetroArch, args...); err != nil {
		return err
	}
	go s.watchLog()

	// capture: VP8 video of this slot's X display and Opus audio of this slot's sink, as RTP on loopback
	vf, _ := os.Create(filepath.Join(s.dir, "ffmpeg_video.log"))
	af, _ := os.Create(filepath.Join(s.dir, "ffmpeg_audio.log"))
	if _, err := s.spawn(vf, nil, "ffmpeg", "-hide_banner", "-loglevel", "warning", "-f", "x11grab", "-draw_mouse", "0",
		"-framerate", "30", "-video_size", fmt.Sprintf("%dx%d", screenW, screenH), "-i", s.Spec.Display,
		"-fps_mode", "cfr", "-r", "30", // constant rate even for a static scene (x11grab only emits on change otherwise)
		"-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", // default threading oversubscribes the CPU and stalls capture "-b:v", "2M", "-g", "30", "-auto-alt-ref", "0",
		"-force_key_frames", "expr:gte(t,n_forced*1)", // a keyframe every second so late joiners decode immediately
		"-lag-in-frames", "0", "-error-resilient", "1", "-pix_fmt", "yuv420p",
		"-f", "rtp", "-payload_type", "96", fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", s.Spec.VideoPort)); err != nil {
		return err
	}
	if _, err := s.spawn(af, []string{"XDG_RUNTIME_DIR=" + env.RuntimeDir}, "ffmpeg", "-hide_banner", "-loglevel", "warning",
		"-f", "pulse", "-i", s.Spec.Sink+".monitor", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
		"-application", "lowdelay", "-frame_duration", "20",
		"-f", "rtp", "-payload_type", "111", fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", s.Spec.AudioPort)); err != nil {
		return err
	}

	inj, err := NewInjector(s.Spec.Display)
	if err != nil {
		return fmt.Errorf("input injector: %v", err)
	}
	s.input = inj
	return nil
}

// SlotInput is how a browser's input reaches ITS emulator (never another slot).
type SlotInput interface {
	Button(name string, down bool)
	Touch(x, y float64, down bool, move bool) // x,y: normalised over the WHOLE video frame (both DS screens)
	Close()
}

// watchLog follows RetroArch's log to learn the DS MAC and whether the Netplay link / multiplayer layer came up.
func (s *Slot) watchLog() {
	var off int64
	for {
		f, err := os.Open(s.LogPath)
		if err != nil {
			time.Sleep(300 * time.Millisecond)
			continue
		}
		f.Seek(off, io.SeekStart)
		r := bufio.NewReader(f)
		for {
			line, err := r.ReadString('\n')
			off += int64(len(line))
			if m := reMAC.FindStringSubmatch(line); m != nil {
				s.mu.Lock()
				s.MAC = m[1]
				s.mu.Unlock()
			}
			if reJoined.MatchString(line) {
				s.mu.Lock()
				s.Joined = true
				s.mu.Unlock()
			}
			if reMP.MatchString(line) {
				s.mu.Lock()
				s.CoreMP = true
				s.mu.Unlock()
			}
			if err != nil {
				break
			}
		}
		f.Close()
		time.Sleep(300 * time.Millisecond)
	}
}

func (s *Slot) Stop() {
	s.mu.Lock()
	procs := s.procs
	s.procs = nil
	s.mu.Unlock()
	for i := len(procs) - 1; i >= 0; i-- {
		killGroup(procs[i])
	}
	if s.input != nil {
		s.input.Close()
	}
}

func (s *Slot) Status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := map[string]any{"backend": s.Backend, "id": s.Spec.ID, "display": s.Spec.Display, "sink": s.Spec.Sink, "host": s.Spec.Host,
		"has_cartridge": s.Spec.ROM != "", "netplay_joined": s.Joined, "core_multiplayer": s.CoreMP, "mac": s.MAC, "expected_mac": s.ExpectedMAC, "nick": s.Nick,
		"netplay_port": s.Spec.NetPort, "input_events": s.Events.Load()}
	st["backend"] = s.Backend
	if rtt := s.peerRttUs.Load(); rtt > 0 && s.peerLive.Load() > 0 {
		st["peer_rtt_ms"] = float64(rtt) / 1000.0
	}
	st["peer_connected"] = s.peerLive.Load() > 0
	if s.rt != nil {
		for k, v := range s.rt.Stats() {
			st[k] = v
		}
		if m, ok := st["mac"].(string); ok {
			st["mac"] = m
		}
		active, _ := st["mp_active"].(bool)
		peers, _ := st["mp_peers"].(float64)
		st["netplay_joined"] = active || peers > 0 // bridge connected (client active / host has a peer)
	}
	if s.Video != nil {
		st["video_packets"] = s.Video.Count()
	}
	if s.Audio != nil {
		st["audio_packets"] = s.Audio.Count()
	}
	if s.rt != nil {
		for k, v := range s.rt.Stats() {
			st[k] = v
		}
	}
	return st
}
