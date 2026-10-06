package main

// Download Play assistant: the DS-level setup that a person would do with the stylus (host: game menu -> Multiplayer; guest: DS menu -> DS Download Play -> pick the game),
// done automatically. It "looks" at the console like the user does (the Runtime's raw frame, compared as a 16x16 average-hash with reference screens) and "touches" it through the
// same input path as the touch controls. Screen references are per game and per device: DSLINK_PROFILE_REFS=<json> (private, never in the repository: they are derived
// from the user's own game). Without them the assistant cannot run and the start fails with a friendly message.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

func itoa(i int) string { return strconv.Itoa(i) }

type dlRef struct {
	Top string `json:"top"`
	Bot string `json:"bot"`
}

var drvSeq atomic.Int64

type dlDriver struct {
	slot   *Slot
	refs   map[string]dlRef
	stop   chan struct{}
	report func(string)
	m      *MpSession
}

var errStopped = errors.New("stopped")

func loadRefs() (map[string]dlRef, error) {
	p := os.Getenv("DSLINK_PROFILE_REFS")
	if p == "" {
		return nil, errors.New("no screen references configured")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var r map[string]dlRef
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return r, nil
}

func (d *dlDriver) sleep(dur time.Duration) error {
	select {
	case <-d.stop:
		return errStopped
	case <-time.After(dur):
		return nil
	}
}

func (d *dlDriver) tap(x, y float64, hold, wait time.Duration) error {
	rt := d.slot.rt
	if rt == nil {
		return errors.New("runtime not running")
	}
	rt.Touch(x, y, true, false)
	if err := d.sleep(hold); err != nil {
		return err
	}
	rt.Touch(x, y, false, false)
	return d.sleep(wait)
}

func (d *dlDriver) press(b string, hold, wait time.Duration) error {
	rt := d.slot.rt
	if rt == nil {
		return errors.New("runtime not running")
	}
	rt.Button(b, true)
	if err := d.sleep(hold); err != nil {
		return err
	}
	rt.Button(b, false)
	return d.sleep(wait)
}

func (d *dlDriver) state() string {
	st := d.slot.Status()
	s, _ := st["dl_state"].(string)
	return s
}

func (d *dlDriver) alive() bool {
	st := d.slot.Status()
	open, _ := st["runtime_link_open"].(bool)
	return open
}

// snapshotHash grabs the console's current picture and returns the 16x16 average-hash of both screens (the picture is deleted at once; nothing is kept).
func (d *dlDriver) snapshotHash() (top, bot string, err error) {
	rt := d.slot.rt
	if rt == nil {
		return "", "", errors.New("runtime not running")
	}
	path := filepath.Join(d.slot.dir, fmt.Sprintf("drv_%d.ppm", drvSeq.Add(1)))
	os.Remove(path)
	rt.send(lSnapshot, []byte(path))
	var data []byte
	for i := 0; i < 60; i++ {
		if err := d.sleep(80 * time.Millisecond); err != nil {
			return "", "", err
		}
		if st, e := os.Stat(path); e == nil && st.Size() > 100 {
			d.sleep(60 * time.Millisecond)
			data, _ = os.ReadFile(path)
			break
		}
	}
	os.Remove(path)
	if len(data) == 0 {
		return "", "", errors.New("no snapshot")
	}
	parts := strings.SplitN(string(data[:min(len(data), 40)]), "\n", 4)
	if len(parts) < 4 {
		return "", "", errors.New("bad snapshot")
	}
	var w, h int
	fmt.Sscanf(parts[1], "%d %d", &w, &h)
	hdr := len(parts[0]) + len(parts[1]) + len(parts[2]) + 3
	px := data[hdr:]
	if w < 256 || h < 384 || len(px) < w*h*3 {
		return "", "", errors.New("unexpected snapshot size")
	}
	hash := func(y0 int) string {
		var g []int
		sum := 0
		for y := y0 + 6; y < y0+192; y += 12 {
			for x := 8; x < 256; x += 16 {
				i := (y*w + x) * 3
				v := (int(px[i]) + int(px[i+1]) + int(px[i+2])) / 3
				g = append(g, v)
				sum += v
			}
		}
		avg := float64(sum) / float64(len(g))
		var sb strings.Builder
		for _, v := range g {
			if float64(v) > avg {
				sb.WriteByte('1')
			} else {
				sb.WriteByte('0')
			}
		}
		return sb.String()
	}
	return hash(0), hash(192), nil
}

func dist(a, b string) int {
	n := 0
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			n++
		}
	}
	return n
}

// screenIs: does the console show the reference screen? which = "top" | "bot" | "both".
func (d *dlDriver) screenIs(name, which string, tol int) (bool, error) {
	ref, ok := d.refs[name]
	if !ok {
		return false, fmt.Errorf("missing reference screen %s", name)
	}
	t, b, err := d.snapshotHash()
	if err != nil {
		return false, err
	}
	dt, db := dist(t, ref.Top), dist(b, ref.Bot)
	switch which {
	case "top":
		return dt <= tol, nil
	case "bot":
		return db <= tol, nil
	}
	return dt <= tol && db <= tol, nil
}

func (d *dlDriver) waitState(states []string, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		s := d.state()
		for _, w := range states {
			if s == w {
				return true
			}
		}
		if d.sleep(500*time.Millisecond) != nil || !d.alive() {
			return false
		}
	}
	return false
}

func (d *dlDriver) waitScreen(name, which string, tol int, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if ok, err := d.screenIs(name, which, tol); err == nil && ok {
			return true
		}
		if d.sleep(time.Second) != nil || !d.alive() {
			return false
		}
	}
	return false
}

// goTo repeats `action` until the console shows `name` (every retry is a real input; a wrong tap in a game goes somewhere else, so actions are state-aware).
func (d *dlDriver) goTo(name, which string, tol, tries int, wait time.Duration, action func() error) (bool, error) {
	for i := 0; i < tries; i++ {
		if !d.alive() {
			return false, errors.New("console stopped")
		}
		if ok, err := d.screenIs(name, which, tol); err != nil {
			return false, err
		} else if ok {
			return true, nil
		}
		if err := action(); err != nil {
			return false, err
		}
		if err := d.sleep(wait); err != nil {
			return false, err
		}
	}
	return d.screenIs(name, which, tol)
}

func (d *dlDriver) ifScreen(name, which string, tol int, fn func() error) error {
	if ok, err := d.screenIs(name, which, tol); err != nil {
		return err
	} else if ok {
		return fn()
	}
	return nil
}

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

// ---------------------------------------------------------------- Mario Party DS profile (single-card Download Play)

func (m *MpSession) newDriver(slot *Slot, stop chan struct{}) (*dlDriver, error) {
	refs, err := loadRefs()
	if err != nil {
		return nil, err
	}
	return &dlDriver{slot: slot, refs: refs, stop: stop, m: m}, nil
}

func (m *MpSession) runHostDriver(room *Room, mode, profile string, stop chan struct{}) error {
	d, err := m.newDriver(room.Slots[0], stop)
	if err != nil {
		return err
	}
	if err := d.sleep(14 * time.Second); err != nil { // boot + title screen
		return err
	}
	ok, err := d.goTo("host_select_data", "both", 40, 8, 3*time.Second, func() error { return d.tap(0.5, 0.9, ms(300), 3*time.Second) })
	if err != nil || !ok {
		return fmt.Errorf("host: save screen: %v", err)
	}
	ok, err = d.goTo("host_main_menu", "bot", 40, 6, 3*time.Second, func() error {
		return d.ifScreen("host_select_data", "both", 40, func() error {
			if e := d.tap(0.5, 0.66, ms(400), 1500*time.Millisecond); e != nil {
				return e
			}
			return d.tap(0.88, 0.97, ms(400), 3*time.Second)
		})
	})
	if err != nil || !ok {
		return fmt.Errorf("host: main menu: %v", err)
	}
	ok, err = d.goTo("host_find_players", "top", 40, 6, 3*time.Second, func() error {
		return d.ifScreen("host_main_menu", "bot", 40, func() error {
			if e := d.tap(0.5, 0.80, ms(400), 1500*time.Millisecond); e != nil {
				return e
			}
			return d.tap(0.88, 0.97, ms(400), 3*time.Second)
		})
	})
	if err != nil || !ok {
		return fmt.Errorf("host: multiplayer menu: %v", err)
	}
	m.setStep("Ricerca partita…")
	if !d.waitState([]string{"DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"}, 240*time.Second) {
		return errors.New("host: the other console never asked for the game")
	}
	m.setStep("Download Play…")
	if !d.waitState([]string{"DOWNLOAD_VERIFY"}, 400*time.Second) {
		return errors.New("host: transfer did not complete")
	}
	if !d.waitScreen("host_p2_joined", "bot", 60, 40*time.Second) {
		return errors.New("host: player 2 not listed")
	}
	if err := d.tap(0.88, 0.97, ms(400), 3*time.Second); err != nil { // OK -> start
		return err
	}
	m.setStep("Avvio partita…")
	if !d.waitState([]string{"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 240*time.Second) || !d.waitState([]string{"GAME_HANDSHAKE", "LOBBY"}, 240*time.Second) {
		return errors.New("host: game did not start")
	}
	d.waitScreen("host_you_are_p1", "bot", 40, 60*time.Second)
	for i := 0; i < 8; i++ {
		if ok, _ := d.screenIs("host_select_mode", "bot", 60); ok {
			return nil
		}
		if i >= 5 && (d.state() == "LOBBY" || d.state() == "IN_GAME") {
			return nil
		}
		if err := d.ifScreen("host_you_are_p1", "bot", 40, func() error { return d.tap(0.5, 0.79, ms(400), time.Second) }); err != nil {
			return err
		}
		if err := d.sleep(3 * time.Second); err != nil {
			return err
		}
	}
	return errors.New("host: lobby not reached")
}

func (m *MpSession) runGuestDriver(slot *Slot, profile string, stop chan struct{}) error {
	d, err := m.newDriver(slot, stop)
	if err != nil {
		return err
	}
	if err := d.sleep(14 * time.Second); err != nil { // firmware boot
		return err
	}
	ok, err := d.goTo("client_ds_menu", "bot", 40, 8, 3*time.Second, func() error { return d.tap(0.5, 0.75, ms(400), 1500*time.Millisecond) })
	if err != nil || !ok {
		return fmt.Errorf("guest: DS menu: %v", err)
	}
	ok, err = d.goTo("client_dl_open", "bot", 40, 6, 3*time.Second, func() error { return d.tap(0.68, 0.72, ms(300), 2*time.Second) })
	if err != nil || !ok {
		return fmt.Errorf("guest: Download Play: %v", err)
	}
	m.setStep("Ricerca partita…")
	if !d.waitState([]string{"GAME_DISCOVERED", "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"}, 300*time.Second) {
		return errors.New("guest: no game found")
	}
	d.waitScreen("client_discovered", "bot", 40, 20*time.Second)
	for i := 0; i < 10; i++ {
		switch d.state() {
		case "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY":
			i = 99
			continue
		}
		if err := d.tap(0.5, 0.67, ms(300), 2*time.Second); err != nil {
			return err
		}
		if err := d.press("a", ms(250), 3*time.Second); err != nil {
			return err
		}
	}
	m.setStep("Download Play…")
	if !d.waitState([]string{"DOWNLOAD_VERIFY", "CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 500*time.Second) {
		return errors.New("guest: download did not complete")
	}
	m.setStep("Avvio partita…")
	if !d.waitState([]string{"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 400*time.Second) || !d.waitState([]string{"GAME_HANDSHAKE", "LOBBY"}, 400*time.Second) {
		return errors.New("guest: game did not start")
	}
	d.waitScreen("client_you_are_p2", "bot", 40, 60*time.Second)
	for i := 0; i < 8; i++ {
		if ok, _ := d.screenIs("client_lobby", "bot", 60); ok {
			return nil
		}
		if i >= 5 && (d.state() == "LOBBY" || d.state() == "IN_GAME") {
			return nil
		}
		if err := d.ifScreen("client_you_are_p2", "bot", 40, func() error { return d.tap(0.5, 0.79, ms(400), 4*time.Second) }); err != nil {
			return err
		}
		if err := d.sleep(3 * time.Second); err != nil {
			return err
		}
	}
	return errors.New("guest: lobby not reached")
}
