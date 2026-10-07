package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A browser guest (the iPhone) plays through the host's own gateway: join by code and by the QR's URL, Hosted is forced, a vanished browser is handled like a lost peer.
func TestWebGuestJoinsThroughTheHostGateway(t *testing.T) {
	d := newTwoDev(t)
	hmux := http.NewServeMux()
	d.host.registerMp(hmux)
	front := httptest.NewServer(hmux)
	defer front.Close()
	d.host.httpPort, _ = parsePort(front.URL)
	if e := d.host.mp.Create("g1", "distributed"); e != nil { // even a forced Distributed host must give a browser Hosted
		t.Fatal(e)
	}
	v := d.host.mp.view(false)
	code, qr := v["code"].(string), v["qr"].(string)
	sid := strings.Repeat("ab12", 5)
	call := func(op string, body string) (int, map[string]any) {
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		req, _ := http.NewRequest("POST", front.URL+"/g/"+sid+"/api/mp/"+op, rd)
		req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var j map[string]any
		json.NewDecoder(resp.Body).Decode(&j)
		return resp.StatusCode, j
	}
	if st, _ := call("join", `{"code":"abc"}`); st != 400 {
		t.Fatalf("a malformed code must be refused (%d)", st)
	}
	bad := "000000"
	if bad == code {
		bad = "000001"
	}
	if st, j := call("join", `{"code":"`+bad+`"}`); st != 400 || j["error"].(map[string]any)["code"] != "bad_code" {
		t.Fatalf("a wrong code must be refused: %d %v", st, j)
	}
	forged := strings.Replace(qr, "&s=", "&s=00", 1)[:len(qr)] // a QR whose secret is wrong is refused
	if st, j := call("join", `{"payload":"`+forged+`"}`); st != 400 || j["error"].(map[string]any)["code"] != "bad_code" {
		t.Fatalf("a QR with the wrong secret must be refused: %d %v", st, j)
	}
	if st, j := call("join", `{"payload":"`+qr+`"}`); st != 200 { // the real QR (the iPhone's Camera opened its URL; the guest page sends it as is)
		t.Fatalf("join by the QR address: %d %v", st, j)
	}
	waitFor(t, "browser guest connected, host CONNECTED", func() bool { return stateOf(d.host) == MpConnected })
	players := d.host.mp.view(false)["players"].([]map[string]any)
	if len(players) != 2 || players[1]["name"] != "iPhone" {
		t.Fatalf("the host's lobby names the browser guest: %v", players)
	}
	hostSession := d.host.mp
	hostSession.mu.Lock()
	g := hostSession.players[1]
	web := g != nil && g.web
	hostSession.mu.Unlock()
	if !web {
		t.Fatal("the host knows this guest is a browser")
	}
	if eff, _ := hostSession.decideMode(); eff != "hosted" {
		t.Fatalf("a browser guest always gets Hosted, got %s", eff)
	}
	// the browser's own view: guest role, platform.web, a stream base relative to its own origin
	req, _ := http.NewRequest("GET", front.URL+"/g/"+sid+"/api/mp/state", nil)
	resp, _ := http.DefaultClient.Do(req)
	var sv map[string]any
	json.NewDecoder(resp.Body).Decode(&sv)
	resp.Body.Close()
	if sv["role"] != "guest" || sv["platform"].(map[string]any)["web"] != true || sv["platform"].(map[string]any)["native"] != false {
		t.Fatalf("web guest view: %v", sv)
	}
	if st, _ := call("ready", `{"ready":true}`); st != 200 {
		t.Fatal("ready")
	}
	waitFor(t, "host READY", func() bool { return stateOf(d.host) == MpReady })
	// a SECOND browser joins as PLAYER 3: the room leaves READY until it is ready too; a third browser finds the room full
	sid2 := strings.Repeat("cd34", 5)
	call2 := func(sid, op, body string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", front.URL+"/g/"+sid+"/api/mp/"+op, strings.NewReader(body))
		req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var j map[string]any
		json.NewDecoder(resp.Body).Decode(&j)
		return resp.StatusCode, j
	}
	if st, j := call2(sid2, "join", `{"code":"`+code+`"}`); st != 200 {
		t.Fatalf("a second browser guest must be accepted: %d %v", st, j)
	}
	waitFor(t, "host leaves READY because player 3 is not ready", func() bool { return stateOf(d.host) == MpConnected })
	pl := d.host.mp.view(false)["players"].([]map[string]any)
	if len(pl) != 3 || pl[1]["slot"] != 1 || pl[2]["slot"] != 2 {
		t.Fatalf("the lobby lists host, PLAYER 2 and PLAYER 3 in join order: %v", pl)
	}
	var sv2 map[string]any
	waitFor(t, "the second guest knows it is PLAYER 3 and sees everybody", func() bool {
		rq, _ := http.NewRequest("GET", front.URL+"/g/"+sid2+"/api/mp/state", nil)
		rs, _ := http.DefaultClient.Do(rq)
		sv2 = nil
		json.NewDecoder(rs.Body).Decode(&sv2)
		rs.Body.Close()
		return sv2["you"] == float64(2) && len(sv2["players"].([]any)) == 3
	})
	sid3 := strings.Repeat("ef56", 5)
	if st, j := call2(sid3, "join", `{"code":"`+code+`"}`); st != 400 || j["error"].(map[string]any)["code"] != "room_full" {
		t.Fatalf("a third guest must find the room full: %d %v", st, j)
	}
	if st, _ := call2(sid2, "ready", `{"ready":true}`); st != 200 {
		t.Fatal("ready 2")
	}
	waitFor(t, "host READY with both guests ready", func() bool { return stateOf(d.host) == MpReady })
	// the first browser goes away: the second guest stays and the room is still startable (START works with one guest too)
	hostSession.mu.Lock()
	wg := d.host.webg.byID[sid]
	hostSession.mu.Unlock()
	wg.m.mu.Lock()
	wg.m.webSeen = time.Now().Add(-2 * mpWebBrowserGrace) // as if no request came for a long while
	wg.m.mu.Unlock()
	keep := d.host.webg.byID[sid2]
	stop := make(chan struct{})
	go func() { // the second browser keeps polling like its page does
		for {
			select {
			case <-stop:
				return
			case <-time.After(500 * time.Millisecond):
				call2(sid2, "ready", `{"ready":true}`)
			}
		}
	}()
	defer close(stop)
	waitFor(t, "the vanished first guest is dropped, the second stays", func() bool {
		hostSession.mu.Lock()
		defer hostSession.mu.Unlock()
		return hostSession.players[1] == nil && hostSession.players[2] != nil
	})
	if st := stateOf(d.host); st != MpReady && st != MpConnected {
		t.Fatalf("with one guest left the room stays open, state %s", st)
	}
	_ = keep
}

func TestQRCarriesAWebAddressAndBothFormsParse(t *testing.T) {
	url := "http://192.168.1.50:8765/guest/?c=123456&s=0123456789abcdef0123456789abcdef&r=ab12&u=47531"
	c, s, h, r, u, ok := parseJoinPayload(url)
	if !ok || c != "123456" || len(s) != 32 || h != "192.168.1.50:8765" || r != "ab12" || u != 47531 {
		t.Fatalf("URL form: %v %v %v %v %v %v", c, s, h, r, u, ok)
	}
	if _, _, _, _, _, ok := parseJoinPayload(strings.Replace(url, "http://", "dslink://join?", 1)[:0] + "dslink://join?c=123456&s=0123456789abcdef0123456789abcdef&h=1.2.3.4:5&r=x&u=1"); !ok {
		t.Fatal("the older form still parses")
	}
	if _, _, _, _, _, ok := parseJoinPayload("http://evil.example/other?c=123456"); ok {
		t.Fatal("a web address that is not the guest page is not a join code")
	}
	if webDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)") != "iPhone" || webDeviceName("Mozilla (X11; Linux)") != "Browser" {
		t.Fatal("device names")
	}
}

func parsePort(u string) (int, error) {
	i := strings.LastIndex(u, ":")
	n := 0
	for _, ch := range u[i+1:] {
		n = n*10 + int(ch-'0')
	}
	return n, nil
}

// START on a game whose Download Play assistant needs screen references (Mario Party DS) when this device has none: the host is told why and the LOBBY STAYS AS IT IS
// (same room, same guest session, same slot and token). Before, the quiet setup retry ran out and the guest's page showed "PARTITA TERMINATA: Non riesco a trovare la partita".
func TestStartWithoutScreenReferencesKeepsTheLobbyAndTheGuestSession(t *testing.T) {
	d := newTwoDev(t)
	os.Unsetenv("DSLINK_PROFILE_REFS")
	fw := t.TempDir()
	for _, f := range []string{"bios7.bin", "bios9.bin", "firmware.bin"} {
		os.WriteFile(filepath.Join(fw, f), []byte("x"), 0o600)
	}
	d.host.env.FirmwareDir = fw
	os.WriteFile(filepath.Join(d.host.libDir(), "mp.nds"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(d.host.libDir(), "mp.json"), []byte(`{"id":"mp","title":"Mario Party DS","gameCode":"A8TE","size":1}`), 0o600)
	hmux := http.NewServeMux()
	d.host.registerMp(hmux)
	front := httptest.NewServer(hmux)
	defer front.Close()
	d.host.httpPort, _ = parsePort(front.URL)
	if e := d.host.mp.Create("mp", "hosted"); e != nil {
		t.Fatal(e)
	}
	code := d.host.mp.view(false)["code"].(string)
	sid := strings.Repeat("ab12", 5)
	post := func(op, body string) int {
		req, _ := http.NewRequest("POST", front.URL+"/g/"+sid+"/api/mp/"+op, strings.NewReader(body))
		req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	guestView := func() map[string]any {
		rq, _ := http.NewRequest("GET", front.URL+"/g/"+sid+"/api/mp/state", nil)
		rs, err := http.DefaultClient.Do(rq)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Body.Close()
		var v map[string]any
		json.NewDecoder(rs.Body).Decode(&v)
		return v
	}
	if st := post("join", `{"code":"`+code+`"}`); st != 200 {
		t.Fatalf("join: %d", st)
	}
	if st := post("ready", `{"ready":true}`); st != 200 {
		t.Fatal("ready")
	}
	waitFor(t, "host READY", func() bool { return stateOf(d.host) == MpReady })
	before := guestView()
	e := d.host.mp.Start()
	if e == nil || e.Code != "no_refs" {
		t.Fatalf("START without screen references must be refused with no_refs, got %v", e)
	}
	if stateOf(d.host) != MpReady {
		t.Fatalf("the host stays in READY (lobby open), got %s", stateOf(d.host))
	}
	time.Sleep(1500 * time.Millisecond) // the guest keeps polling the host: it must still be in the same session
	after := guestView()
	if after["role"] != "guest" || after["you"] != before["you"] || after["code"] != before["code"] {
		t.Fatalf("the guest session changed: before %v after %v", before["you"], after["you"])
	}
	if s := after["state"]; s != string(MpReady) && s != string(MpConnected) {
		t.Fatalf("the guest must still be in the lobby, got %v (error %v)", s, after["error"])
	}
	if _, ok := after["ingame"]; ok {
		t.Fatal("no game session may exist")
	}
	if len(d.host.mp.guestIdx(true)) != 1 {
		t.Fatal("the guest is still in the host's room")
	}
}
