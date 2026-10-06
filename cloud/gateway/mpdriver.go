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
	guests []*Slot // host driver, Hosted: the consoles of the guests (their own states tell when every one of them has downloaded / booted the game)
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

// refOr: the reference screen for this player if the private profile has one, else the two-player one
func (d *dlDriver) refOr(name, fallback string) string {
	if _, ok := d.refs[name]; ok {
		return name
	}
	return fallback
}

// ownDownloadDone: THIS console's own transfer is over. With several clients on one radio the state machine also sees the other clients' frames, so its state cannot tell:
// the console associated by itself (assoc_req_tx) and the payload (~700 KB of 292-byte frames) has been delivered to it since. (After the transfer the keep-alive polling goes on,
// so "bytes stopped growing" is not a usable signal.)
func (d *dlDriver) ownDownloadDone(timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	base, assocAt := -1.0, time.Time{}
	for time.Now().Before(end) {
		c, _ := d.slot.Status()["dl_counters"].(map[string]any)
		b, _ := c["data_bytes_rx"].(float64)
		assoc, _ := c["assoc_req_tx"].(float64)
		if assoc >= 1 && base < 0 {
			base, assocAt = b, time.Now()
		}
		if base >= 0 && b-base > 650000 && time.Since(assocAt) > 8*time.Second {
			return true
		}
		if d.sleep(500*time.Millisecond) != nil || !d.alive() {
			return false
		}
	}
	return false
}

// allGuests: every guest console reached one of the states (the host's own radio view only follows the first client)
func (d *dlDriver) allGuests(states []string, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		all := true
		for _, g := range d.guests {
			st, _ := g.Status()["dl_state"].(string)
			ok := false
			for _, w := range states {
				if st == w {
					ok = true
				}
			}
			all = all && ok
		}
		if all {
			return true
		}
		if d.sleep(500*time.Millisecond) != nil || !d.alive() {
			return false
		}
	}
	return false
}

func (d *dlDriver) alive() bool {
	st := d.slot.Status()
	open, _ := st["runtime_link_open"].(bool)
	return open
}

// snapshotHash grabs the console's current picture and returns the 16x16 average-hash of both screens (the picture is deleted at once; nothing is kept).
func (d *dlDriver) snapshotHash() (top, bot string, err error) {
	w, h, px, err := d.capture()
	if err != nil {
		return "", "", err
	}
	return hashScreens(w, h, px)
}

// capture asks the Runtime for its current raw frame (256x384: both DS screens) and deletes the file at once.
func (d *dlDriver) capture() (w, h int, px []byte, err error) {
	rt := d.slot.rt
	if rt == nil {
		return 0, 0, nil, errors.New("runtime not running")
	}
	path := filepath.Join(d.slot.dir, fmt.Sprintf("drv_%d.ppm", drvSeq.Add(1)))
	os.Remove(path)
	rt.send(lSnapshot, []byte(path))
	var data []byte
	for i := 0; i < 60; i++ {
		if err := d.sleep(80 * time.Millisecond); err != nil {
			return 0, 0, nil, err
		}
		if st, e := os.Stat(path); e == nil && st.Size() > 100 {
			d.sleep(60 * time.Millisecond)
			data, _ = os.ReadFile(path)
			break
		}
	}
	os.Remove(path)
	if len(data) == 0 {
		return 0, 0, nil, errors.New("no snapshot")
	}
	parts := strings.SplitN(string(data[:min(len(data), 40)]), "\n", 4)
	if len(parts) < 4 {
		return 0, 0, nil, errors.New("bad snapshot")
	}
	fmt.Sscanf(parts[1], "%d %d", &w, &h)
	hdr := len(parts[0]) + len(parts[1]) + len(parts[2]) + 3
	px = data[hdr:]
	if w < 256 || h < 384 || len(px) < w*h*3 {
		return 0, 0, nil, errors.New("unexpected snapshot size")
	}
	return w, h, px, nil
}

func hashScreens(w, h int, px []byte) (top, bot string, err error) {
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

// nearest: the reference screen closest to the current picture (developer log only: "name distance").
func (d *dlDriver) nearest(which string) string {
	t, b, err := d.snapshotHash()
	if err != nil {
		return "?"
	}
	best, bd := "none", 1<<30
	for name, ref := range d.refs {
		x := dist(b, ref.Bot)
		if which == "top" {
			x = dist(t, ref.Top)
		}
		if x < bd {
			best, bd = name, x
		}
	}
	return best + " " + itoa(bd)
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

func (m *MpSession) note(format string, a ...any) {
	m.mu.Lock()
	m.logf("driver: "+format, a...)
	m.mu.Unlock()
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
	nG := 1
	m.mu.Lock()
	if mode == "hosted" && m.hostedGuests > 0 {
		nG = m.hostedGuests
	}
	m.mu.Unlock()
	for i := 1; i <= nG && i < len(room.Slots); i++ {
		d.guests = append(d.guests, room.Slots[i])
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
	m.note("host: waiting for the other console")
	if !d.waitState([]string{"DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"}, 240*time.Second) {
		return errors.New("host: the other console never asked for the game")
	}
	m.setStep("Download Play…")
	if nG > 1 { // two guests download at the same time: the host starts the game only when BOTH consoles hold it
		if !m.waitGuestsDownloaded(nG, 500*time.Second, stop) {
			return errors.New("host: not every guest completed the download")
		}
	} else if !d.waitState([]string{"DOWNLOAD_VERIFY"}, 400*time.Second) {
		return errors.New("host: transfer did not complete")
	}
	m.note("host: transfer complete")
	if os.Getenv("DSLINK_MP_TEST_FAIL_FIRST") == "1" { // tests only: proves that a failed first setup is redone quietly
		m.mu.Lock()
		first := m.attempt == 1
		m.mu.Unlock()
		if first {
			return errors.New("test: forced failure of the first attempt")
		}
	}
	if err := d.sleep(12 * time.Second); err != nil { // let the other console finish verifying what it received: starting before that leaves it waiting forever
		return err
	}
	joined := "host_p2_joined"
	if nG > 1 {
		joined = d.refOr("host_p23_joined", "")
	}
	if joined != "" && !d.waitScreen(joined, "bot", 60, 40*time.Second) {
		return errors.New("host: the players are not listed")
	}
	m.setStep("Avvio partita…")
	started := false
	for try := 0; try < 10 && !started; try++ { // OK -> start; state-aware and quick: a tap that is ignored must not leave the other console waiting long enough to be dropped
		if onP1, _ := d.screenIs("host_you_are_p1", "bot", 40); onP1 && try > 0 {
			break // the game already started on this console: tapping again would go somewhere else
		}
		m.note("host: OK (try %d, state %s, screen %s)", try+1, d.state(), d.nearest("bot"))
		var err error
		switch try % 3 { // the OK button sits at the very edge of the touch screen: vary the touch point, and use the A button as the same "OK"
		case 0:
			err = d.tap(0.88, 0.97, ms(400), 1500*time.Millisecond)
		case 1:
			err = d.tap(0.85, 0.94, ms(500), 1500*time.Millisecond)
		default:
			err = d.press("a", ms(300), 1500*time.Millisecond)
		}
		if err != nil {
			return err
		}
		if nG > 1 {
			started = d.allGuests([]string{"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 8*time.Second)
		} else {
			started = d.waitState([]string{"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 6*time.Second)
		}
	}
	if !started {
		return errors.New("host: the game did not start after OK")
	}
	if !d.waitState([]string{"GAME_HANDSHAKE", "LOBBY"}, 100*time.Second) || (nG > 1 && !d.allGuests([]string{"GAME_HANDSHAKE", "LOBBY"}, 100*time.Second)) {
		return errors.New("host: game handshake did not complete")
	}
	m.note("host: game handshake reached")
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

// guestDownloaded / waitGuestsDownloaded: Hosted with two guests, the host's driver waits for both guests' downloads
func (m *MpSession) guestDownloaded(idx int) {
	m.mu.Lock()
	if m.dlDone == nil {
		m.dlDone = map[int]bool{}
	}
	m.dlDone[idx] = true
	m.mu.Unlock()
}

func (m *MpSession) waitGuestsDownloaded(n int, timeout time.Duration, stop chan struct{}) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		m.mu.Lock()
		done := len(m.dlDone)
		m.mu.Unlock()
		if done >= n {
			return true
		}
		select {
		case <-stop:
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
	return false
}

// runGuestDriver: the DS menu of ONE guest console (idx 0 = PLAYER 2, idx 1 = PLAYER 3): Download Play -> pick the game -> download -> boot -> lobby.
func (m *MpSession) runGuestDriver(slot *Slot, profile string, stop chan struct{}, idx int) error {
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
	m.note("guest: Download Play open, waiting for the host")
	if !d.waitState([]string{"GAME_DISCOVERED", "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"}, 300*time.Second) {
		return errors.New("guest: no game found")
	}
	d.waitScreen("client_discovered", "bot", 40, 20*time.Second)
	m.mu.Lock()
	multi := m.hostedGuests > 1
	m.mu.Unlock()
	if multi && idx > 0 && !m.waitGuestsDownloaded(idx, 400*time.Second, stop) { // two guests: the downloads go one after the other
		return errors.New("guest: the previous guest never finished its download")
	}
	for i := 0; i < 12; i++ {
		if multi { // the radio is shared: the state machine would already report the other guest's transfer, so look at the screen
			if ok, _ := d.screenIs("client_downloading", "bot", 60); ok {
				break
			}
		} else {
			switch d.state() {
			case "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY":
				i = 99
				continue
			}
		}
		if err := d.tap(0.5, 0.67, ms(300), 2*time.Second); err != nil {
			return err
		}
		if err := d.press("a", ms(250), 3*time.Second); err != nil {
			return err
		}
	}
	m.setStep("Download Play…")
	m.note("guest %d: download requested (state %s)", idx+2, d.state())
	if multi {
		if !d.ownDownloadDone(500 * time.Second) {
			return errors.New("guest: download did not complete")
		}
	} else if !d.waitState([]string{"DOWNLOAD_VERIFY", "CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 500*time.Second) {
		return errors.New("guest: download did not complete")
	}
	m.guestDownloaded(idx)
	m.setStep("Avvio partita…")
	m.note("guest: waiting for the host to start (state %s)", d.state())
	if !d.waitState([]string{"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 400*time.Second) || !d.waitState([]string{"GAME_HANDSHAKE", "LOBBY"}, 400*time.Second) {
		return errors.New("guest: game did not start")
	}
	youAre, lobby := d.refOr(fmt.Sprintf("client_you_are_p%d", idx+2), "client_you_are_p2"), d.refOr(fmt.Sprintf("client_lobby_p%d", idx+2), "client_lobby")
	d.waitScreen(youAre, "bot", 40, 60*time.Second)
	for i := 0; i < 8; i++ {
		if ok, _ := d.screenIs(lobby, "bot", 60); ok {
			return nil
		}
		if i >= 5 && (d.state() == "LOBBY" || d.state() == "IN_GAME") {
			return nil
		}
		if err := d.ifScreen(youAre, "bot", 40, func() error { return d.tap(0.5, 0.79, ms(400), 4*time.Second) }); err != nil {
			return err
		}
		if err := d.sleep(3 * time.Second); err != nil {
			return err
		}
	}
	return errors.New("guest: lobby not reached")
}
