package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	// a second browser finds the room full
	sid2 := strings.Repeat("cd34", 5)
	req2, _ := http.NewRequest("POST", front.URL+"/g/"+sid2+"/api/mp/join", strings.NewReader(`{"code":"`+code+`"}`))
	r2, _ := http.DefaultClient.Do(req2)
	var j2 map[string]any
	json.NewDecoder(r2.Body).Decode(&j2)
	r2.Body.Close()
	if r2.StatusCode != 400 || j2["error"].(map[string]any)["code"] != "room_full" {
		t.Fatalf("a second guest must find the room full: %d %v", r2.StatusCode, j2)
	}
	// the browser goes away (Safari in the background): the host stops hearing it and the lobby opens up again
	hostSession.mu.Lock()
	wg := d.host.webg.byID[sid]
	hostSession.mu.Unlock()
	wg.m.mu.Lock()
	wg.m.webSeen = time.Now().Add(-2 * mpWebBrowserGrace) // as if no request came for a long while
	wg.m.mu.Unlock()
	// (the browser's next request would refresh webSeen; none comes)
	waitFor(t, "host notices the vanished browser", func() bool { return stateOf(d.host) == MpWaitingForPeer })
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
