#!/usr/bin/env python3
"""cf_prepare.py against a mock Cloudflare API, with R2 enabled and without it (R2 is OPTIONAL). Stdlib only: python3 scripts/test_cf_prepare.py"""
import http.server, json, os, re, subprocess, sys, tempfile, threading, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODE = {"r2": "ok"}          # ok | 10042 | forbidden | public


class Mock(http.server.BaseHTTPRequestHandler):
    log = []

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def handle_any(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("content-length") or 0); self.rfile.read(n)
        Mock.log.append(f"{self.command} {path}")
        if "/d1/database" in path:
            return self.reply(200, {"success": True, "result": [{"name": "dslink", "uuid": "11111111-2222-3333-4444-555555555555"}] if self.command == "GET" else {"name": "dslink", "uuid": "11111111-2222-3333-4444-555555555555"}})
        if path.endswith("/workers/subdomain"):
            return self.reply(200, {"success": True, "result": {"subdomain": "tester"}})
        if "/r2/buckets" in path:
            m = MODE["r2"]
            if m == "10042":
                return self.reply(403, {"success": False, "errors": [{"code": 10042, "message": "Please enable R2 through the Cloudflare Dashboard."}]})
            if m == "forbidden":
                return self.reply(403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})
            if path.endswith("/domains/managed"):
                return self.reply(200, {"success": True, "result": {"enabled": m == "public"}})
            if path.endswith("/domains/custom"):
                return self.reply(200, {"success": True, "result": {"domains": []}})
            return self.reply(200, {"success": True, "result": {"name": "dslink-private"}})
        return self.reply(404, {"success": False, "errors": [{"code": 7003, "message": "no route"}]})

    do_GET = do_POST = do_PUT = do_DELETE = handle_any

    def log_message(self, *a):
        pass


def run(r2, extra_env=None):
    MODE["r2"] = r2; Mock.log.clear()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock); threading.Thread(target=srv.serve_forever, daemon=True).start()
    out = os.path.join(tempfile.mkdtemp(), "wrangler.prod.jsonc")
    env = {**os.environ, "CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ACCOUNT_ID": "acc", "CLOUDFLARE_API_BASE": f"http://127.0.0.1:{srv.server_port}", "DSLINK_PROD_CONFIG": out,
           "DSLINK_WRANGLER_CONFIG": os.path.join(ROOT, "cloud/worker/wrangler.jsonc"), **(extra_env or {})}
    p = subprocess.run([sys.executable, os.path.join(ROOT, "scripts/cf_prepare.py")], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    srv.shutdown()
    kv = dict(l.split("=", 1) for l in p.stdout.splitlines() if re.match(r"^[A-Z0-9_]+=", l))
    cfg = open(out).read() if os.path.exists(out) else ""
    return p, kv, cfg, list(Mock.log)


def parse(cfg):
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", re.sub(r"(?m)^\s*//.*$|(?<=\S)\s+//\s.*$", "", cfg)))


class CfPrepare(unittest.TestCase):
    def test_r2_enabled_true(self):
        p, kv, cfg, log = run("ok")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(kv["R2_ENABLED"], "true")
        c = parse(cfg)
        self.assertEqual(c["r2_buckets"], [{"binding": "STORE", "bucket_name": "dslink-private"}])
        self.assertEqual(c["d1_databases"][0]["database_id"], "11111111-2222-3333-4444-555555555555")
        self.assertIn("tester.workers.dev", cfg)

    def test_r2_not_enabled_10042_does_not_fail(self):
        p, kv, cfg, log = run("10042")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(kv["R2_ENABLED"], "false"); self.assertEqual(kv["R2_REASON"], "not_enabled_10042")
        c = parse(cfg)
        self.assertNotIn("r2_buckets", c); self.assertNotIn("STORE", cfg)
        for k in ("d1_databases", "durable_objects", "assets", "migrations"):
            self.assertIn(k, c, k)                                                   # Worker + D1 + Durable Objects + static assets all still there
        self.assertEqual(kv["URL"], "https://dslink-cloud.tester.workers.dev")
        self.assertIn("::notice::", p.stderr); self.assertNotIn("Traceback", p.stderr)

    def test_token_without_r2_permission_does_not_fail(self):
        p, kv, cfg, log = run("forbidden")
        self.assertEqual(p.returncode, 0, p.stderr); self.assertEqual(kv["R2_ENABLED"], "false"); self.assertNotIn("STORE", cfg)

    def test_forced_off_never_calls_r2(self):
        p, kv, cfg, log = run("ok", {"DSLINK_R2": "off"})
        self.assertEqual(p.returncode, 0, p.stderr); self.assertEqual(kv["R2_ENABLED"], "false"); self.assertEqual(kv["R2_REASON"], "disabled_by_DSLINK_R2")
        self.assertFalse([l for l in log if "/r2/" in l]); self.assertNotIn("STORE", cfg)

    def test_a_public_bucket_still_fails(self):
        p, kv, cfg, log = run("public")
        self.assertNotEqual(p.returncode, 0); self.assertIn("must stay private", p.stderr + p.stdout)

    def test_no_secret_in_output(self):
        for m in ("ok", "10042"):
            p, kv, cfg, log = run(m)
            self.assertNotIn("Bearer", p.stdout + p.stderr + cfg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
