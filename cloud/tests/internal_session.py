#!/usr/bin/env python3
"""Gateway <-> Worker contract: the container provisions a session from a private content server using a one-time ticket,
runs both emulators, persists the host's SRAM on end, and wipes everything. A fake 'Worker' plays the Worker's role.
usage: internal_session.py <gateway-url> <rom.nds>"""
import hashlib, http.server, json, os, sys, threading, time, urllib.request

gw, rom_path = sys.argv[1], sys.argv[2]
SECRET, TICKET = "internal-secret", "ticket-123"
rom = open(rom_path, "rb").read()
fw2 = bytes([0x5A]) * 262144
seen, saved, used = [], {}, set()
ok = bad = 0


def check(name, cond, detail=""):
    global ok, bad
    print(("PASS " if cond else "FAIL ") + name + (f"  -> {detail}" if detail else ""))
    ok += bool(cond); bad += not cond


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _auth(self):
        return self.headers.get("authorization") == "Bearer " + SECRET and self.headers.get("x-dslink-ticket") == TICKET
    def do_GET(self):
        seen.append(self.path)
        if not self._auth() or self.path in used:
            self.send_response(403); self.end_headers(); return
        used.add(self.path)
        body = rom if "/files/" in self.path else fw2 if "/slot/2/system/firmware.bin" in self.path else None
        if body is None: self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_PUT(self):
        n = int(self.headers["content-length"]); data = self.rfile.read(n)
        if not self._auth(): self.send_response(403); self.end_headers(); return
        saved[self.path] = data
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}/internal/sessions/sess1"


def post(path, body, token=SECRET):
    req = urllib.request.Request(gw + path, data=json.dumps(body).encode(), headers={"content-type": "application/json", **({"authorization": "Bearer " + token} if token else {})}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, {}


manifest = {"sessionId": "sess1", "platform": "nds", "title": "TEST", "files": [{"id": "f1", "role": "rom", "name": "x.nds", "size": len(rom)}],
            "slots": [{"slot": 1, "name": "A", "system": []}, {"slot": 2, "name": "B", "system": ["firmware.bin"]}], "saves": []}
payload = {"manifest": manifest, "ticket": TICKET, "tokens": ["tokA", "tokB"], "contentBase": base}

check("endpoint is closed without the secret", post("/api/internal/session", payload, token="")[0] == 404)
check("endpoint is closed with a wrong secret", post("/api/internal/session", payload, token="nope")[0] == 404)
bad_t = dict(payload, ticket="wrong")
code, _ = post("/api/internal/session", bad_t)
check("a wrong ticket gets no content and no room", code == 502, code)
used.clear(); seen.clear()
code, body = post("/api/internal/session", payload)
check("session provisioned", code == 200 and body.get("ok"), f"{code} {body}")
st = json.load(urllib.request.urlopen(gw + "/api/status"))["room"]
check("room code is the session id; two slots", st and st["code"] == "sess1" and len(st["slots"]) == 2)
check("slot 1 has the cartridge, slot 2 does not (Download Play client)", st["slots"][0]["has_cartridge"] and not st["slots"][1]["has_cartridge"])
check("the guest slot never asked for the ROM: only the host's file was requested, once", [p for p in seen if "/files/" in p] == ["/internal/sessions/sess1/files/f1"])
check("firmware requested for slot 2 only", any("/slot/2/system/firmware.bin" in p for p in seen) and not any("/slot/1/" in p for p in seen))
workdir = os.environ.get("DSLINK_WORKDIR", "/tmp/dslink-cloud")
check("slot 2's own firmware is placed in slot 2's system dir", os.path.exists(f"{workdir}/slot2/system/melonDS DS/firmware.bin") and not os.path.exists(f"{workdir}/slot1/system/melonDS DS/firmware.bin"))
code, _ = post("/api/internal/session", payload)
check("a second session on the same container is refused", code == 409, code)
time.sleep(6)
st = json.load(urllib.request.urlopen(gw + "/api/status"))["room"]
check("host emulator is running at ~60 fps", st["slots"][0].get("fps", 0) > 50, st["slots"][0].get("fps"))
# the host game writes SRAM at runtime? the test ROM does not, so plant a save the way the core would leave it
os.makedirs(f"{workdir}/slot1/saves/melonDS DS", exist_ok=True)
planted = bytes(range(256)) * 4
open(f"{workdir}/slot1/saves/melonDS DS/player1.srm", "wb").write(planted)
code, body = post("/api/internal/end", {})
got = saved.get("/internal/sessions/sess1/save/sram", b"")
check("end flushes the core's SRAM (overwrites the planted file) and persists it through the content server", code == 200 and body.get("saved") and 0 < len(got) <= 8 << 20 and got != planted, f"{len(got)} bytes")
check("room and private files are wiped", not os.path.exists(f"{workdir}/room") and not os.path.exists(f"{workdir}/fw") and not os.path.exists(f"{workdir}/slot2"))
check("no room remains", json.load(urllib.request.urlopen(gw + "/api/status"))["room"] is None)
print(f"{ok}/{ok+bad} checks passed")
sys.exit(1 if bad else 0)
