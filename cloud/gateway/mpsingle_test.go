package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// SINGLE PLAYER needs bios7 + bios9 + firmware (when the app points at a system folder) and NEVER refs.json, not even for a game that has a Download Play profile.
func TestSinglePlayerNeedsTheThreeSystemFilesButNotTheScreenReferences(t *testing.T) {
	d := newTwoDev(t)
	os.Unsetenv("DSLINK_PROFILE_REFS")
	fw := t.TempDir()
	d.host.env.FirmwareDir = fw
	os.WriteFile(filepath.Join(d.host.libDir(), "mp.nds"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(d.host.libDir(), "mp.json"), []byte(`{"id":"mp","title":"Mario Party DS","gameCode":"A8TE","size":1}`), 0o600)
	if e := d.host.mp.StartSingle("mp"); e == nil || e.Code != "no_firmware" {
		t.Fatalf("without the system files Single Player must be refused with no_firmware, got %v", e)
	}
	if stateOf(d.host) != MpIdle {
		t.Fatalf("a refused start leaves the session idle, got %s", stateOf(d.host))
	}
	for _, f := range []string{"bios7.bin", "bios9.bin", "firmware.bin"} {
		os.WriteFile(filepath.Join(fw, f), []byte("x"), 0o600)
	}
	if e := d.host.mp.StartSingle("nope"); e == nil || e.Code != "no_game" {
		t.Fatalf("unknown game: no_game, got %v", e)
	}
	e := d.host.mp.StartSingle("mp") // no refs.json anywhere
	if e != nil {
		t.Fatalf("Single Player must not require refs.json, got %v", e)
	}
	v := d.host.mp.view(false)
	if v["single"] != true || v["code"] != "" || v["qr"] != "" {
		t.Fatalf("single session has no room: %v", v)
	}
	if e := d.host.mp.StartSingle("mp"); e == nil || e.Code != "busy" {
		t.Fatalf("a second start while one is running/starting is refused, got %v", e)
	}
	time.Sleep(300 * time.Millisecond)
	d.host.mp.Reset()
	time.Sleep(300 * time.Millisecond)
}

func TestSingleSaveFoldersAreSeparatePerGame(t *testing.T) {
	d := newTwoDev(t)
	a, b := d.host.saveDirFor("aaaa"), d.host.saveDirFor("bbbb")
	if a == b || filepath.Dir(a) != filepath.Dir(b) || filepath.Base(a) != "aaaa" {
		t.Fatalf("save folders must be keyed by the game id: %s %s", a, b)
	}
	if rel, _ := filepath.Rel(d.host.libDir(), a); filepath.IsAbs(rel) || rel == "" {
		t.Fatalf("saves live next to the library (persistent), not in scratch: %s", a)
	}
}
