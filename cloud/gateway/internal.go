package main

// Cloud session provisioning (called by the Worker's GameSession Durable Object, never by browsers).
//
//   POST /api/internal/session   Authorization: Bearer $DSLINK_INTERNAL_TOKEN
//        { manifest, ticket, tokens:[p1,p2], contentBase }
//   POST /api/internal/end       same bearer; saves the host's SRAM back to private storage, then closes the room
//
// The container pulls the HOST's game and each slot's OWN firmware with a one-time ticket straight from private R2 (via the
// Worker). Nothing is baked into the image and nothing is kept after the room closes: the room directory is deleted.

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

type sessionManifest struct {
	SessionID string `json:"sessionId"`
	Platform  string `json:"platform"`
	Title     string `json:"title"`
	Solo      bool   `json:"solo"`
	Files     []struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"files"`
	Slots []struct {
		Slot   int      `json:"slot"`
		Name   string   `json:"name"`
		System []string `json:"system"`
	} `json:"slots"`
	Saves []struct {
		Kind string `json:"kind"`
	} `json:"saves"`
}

type sessionRequest struct {
	Manifest    sessionManifest `json:"manifest"`
	Ticket      string          `json:"ticket"`
	Tokens      [2]string       `json:"tokens"`
	ContentBase string          `json:"contentBase"`
	// TURN relay (Cloudflare Containers have no inbound UDP: the gateway allocates a relay as a TURN client; browsers use the same TURN service)
	Ice          []webrtc.ICEServer `json:"ice"`
	IceRelayOnly bool               `json:"iceRelayOnly"`
}

func (s *Server) internalAuth(w http.ResponseWriter, r *http.Request) bool {
	tok := s.env.InternalToken
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" || subtle.ConstantTimeCompare([]byte(got), []byte(tok)) != 1 {
		http.NotFound(w, r) // the endpoint does not exist unless a secret is configured
		return false
	}
	return true
}

func (s *Server) fetchPrivate(base, path, ticket, dst string, max int64) error {
	req, _ := http.NewRequest("GET", base+path, nil)
	req.Header.Set("Authorization", "Bearer "+s.env.InternalToken)
	req.Header.Set("X-DSLink-Ticket", ticket)
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("content request refused (%d)", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, io.LimitReader(resp.Body, max+1))
	if err == nil && n > max {
		err = fmt.Errorf("content larger than allowed")
	}
	return err
}

// POST /api/internal/session
func (s *Server) internalSession(w http.ResponseWriter, r *http.Request) {
	if !s.internalAuth(w, r) {
		return
	}
	var req sessionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil || req.Ticket == "" || req.ContentBase == "" || req.Manifest.SessionID == "" {
		jsonOut(w, 400, map[string]string{"error": "invalid request"})
		return
	}
	m := req.Manifest
	if m.Platform != "nds" {
		jsonOut(w, 501, map[string]string{"error": "platform not supported by this runtime build"})
		return
	}
	if u, err := url.Parse(req.ContentBase); err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		jsonOut(w, 400, map[string]string{"error": "invalid content base"})
		return
	}
	s.mu.Lock()
	if s.room != nil {
		s.mu.Unlock()
		jsonOut(w, 409, map[string]string{"error": "container already hosts a session"})
		return
	}
	s.mu.Unlock()

	if len(req.Ice) > 0 {
		s.mu.Lock()
		s.ice, s.relayOnly = req.Ice, req.IceRelayOnly
		s.mu.Unlock()
	}
	dir := filepath.Join(s.env.WorkDir, "room")
	os.RemoveAll(dir)
	os.MkdirAll(dir, 0o700)
	fail := func(code int, msg string, err error) {
		if err != nil {
			log.Printf("session provisioning failed: %s", msg) // no names/paths of private content in logs
		}
		os.RemoveAll(dir)
		os.RemoveAll(filepath.Join(s.env.WorkDir, "fw"))
		jsonOut(w, code, map[string]string{"error": msg})
	}
	var rom string
	for _, f := range m.Files {
		if f.Role != "rom" {
			continue
		}
		rom = filepath.Join(dir, "player1.nds")
		if err := s.fetchPrivate(req.ContentBase, "/files/"+url.PathEscape(f.ID), req.Ticket, rom, 512<<20); err != nil {
			fail(502, "cannot fetch the game", err)
			return
		}
	}
	if rom == "" {
		fail(422, "session has no cartridge", nil)
		return
	}
	info, err := run(s.env.RomCheck, rom)
	if kv := parseKV(info); err != nil || kv["status"] != "OK" {
		fail(422, "invalid ROM", err)
		return
	}
	fwDirs := [2]string{}
	for _, sl := range m.Slots {
		if sl.Slot < 1 || sl.Slot > 2 {
			continue
		}
		d := filepath.Join(s.env.WorkDir, "fw", fmt.Sprintf("slot%d", sl.Slot))
		for _, name := range sl.System {
			if name != "bios7.bin" && name != "bios9.bin" && name != "firmware.bin" {
				continue
			}
			if err := s.fetchPrivate(req.ContentBase, fmt.Sprintf("/slot/%d/system/%s", sl.Slot, name), req.Ticket, filepath.Join(d, name), 4<<20); err != nil {
				fail(502, "cannot fetch system file", err)
				return
			}
			fwDirs[sl.Slot-1] = d
		}
	}
	room := &Room{Solo: m.Solo, Code: m.SessionID, Title: m.Title, Created: time.Now(), Tokens: req.Tokens, FirmwareDirs: fwDirs, ContentBase: req.ContentBase, Ticket: req.Ticket}
	for _, sv := range m.Saves {
		if sv.Kind == "sram" {
			dst := filepath.Join(s.env.WorkDir, "slot1", "saves", "melonDS DS", "player1.srm")
			if err := s.fetchPrivate(req.ContentBase, "/save/sram", req.Ticket, dst, 8<<20); err != nil {
				log.Printf("save restore skipped")
			}
		}
	}
	s.mu.Lock()
	s.room = room
	s.mu.Unlock()
	if err := s.startSlots(room, rom, ""); err != nil {
		log.Printf("session start failed: %v", err)
		s.closeRoom()
		jsonOut(w, 500, map[string]string{"error": "cannot start the emulators"})
		return
	}
	jsonOut(w, 200, map[string]any{"ok": true})
}

// POST /api/internal/end : persist the host's save, then tear everything down
func (s *Server) internalEnd(w http.ResponseWriter, r *http.Request) {
	if !s.internalAuth(w, r) {
		return
	}
	s.mu.Lock()
	room := s.room
	s.mu.Unlock()
	saved := false
	if room != nil && room.ContentBase != "" && room.Slots[0] != nil && room.Slots[0].rt != nil {
		room.Slots[0].rt.send(lSave, nil)
		time.Sleep(1500 * time.Millisecond)
		sav := filepath.Join(s.env.WorkDir, "slot1", "saves", "melonDS DS", "player1.srm")
		if b, err := os.ReadFile(sav); err == nil && len(b) > 0 && len(b) <= 8<<20 {
			req, _ := http.NewRequest("PUT", room.ContentBase+"/save/sram", bytes.NewReader(b))
			req.Header.Set("Authorization", "Bearer "+s.env.InternalToken)
			req.Header.Set("X-DSLink-Ticket", room.Ticket)
			if resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req); err == nil {
				saved = resp.StatusCode == 200
				resp.Body.Close()
			}
		}
	}
	s.closeRoom()
	os.RemoveAll(filepath.Join(s.env.WorkDir, "fw"))
	os.RemoveAll(filepath.Join(s.env.WorkDir, "slot1"))
	os.RemoveAll(filepath.Join(s.env.WorkDir, "slot2"))
	jsonOut(w, 200, map[string]any{"ok": true, "saved": saved})
}
