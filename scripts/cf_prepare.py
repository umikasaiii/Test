#!/usr/bin/env python3
"""Idempotent Cloudflare provisioning for DSLink (run by .github/workflows/deploy.yml; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).

Creates (only if missing): D1 database `dslink` and the PRIVATE R2 bucket `dslink-private` (verifying it has no public access). Writes cloud/worker/wrangler.prod.jsonc
(no secrets inside) with the real D1 id and the account's workers.dev origin. Secrets are set with `wrangler secret put` by the workflow.
Prints `KEY=value` lines for the workflow (never secret values). Stdlib only.
"""
import json, os, re, sys, urllib.request, urllib.error

TOKEN, ACC = os.environ.get("CLOUDFLARE_API_TOKEN"), os.environ.get("CLOUDFLARE_ACCOUNT_ID")
NAME = os.environ.get("DSLINK_WORKER_NAME", "dslink-cloud")
if not TOKEN or not ACC:
    sys.exit("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required")
API = f"https://api.cloudflare.com/client/v4/accounts/{ACC}"

def call(method, path, body=None, ok404=False):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if ok404 and e.code == 404:
            return None
        sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:300]}")

# D1
found = call("GET", "/d1/database?name=dslink")["result"]
d1 = next((d for d in found if d["name"] == "dslink"), None) or call("POST", "/d1/database", {"name": "dslink"})["result"]
CONFIG = os.environ.get("DSLINK_WRANGLER_CONFIG", "cloud/worker/wrangler.jsonc")
# R2: ONE private bucket for the users' own files and saves (the Worker's STORE binding). Private = no r.dev public URL and no custom domain; this script never enables either, and checks it.
if "r2_buckets" in open(CONFIG).read():
    if call("GET", "/r2/buckets/dslink-private", ok404=True) is None:
        call("POST", "/r2/buckets", {"name": "dslink-private"})
    for what, path in (("managed r2.dev public access", "/r2/buckets/dslink-private/domains/managed"), ("custom domains", "/r2/buckets/dslink-private/domains/custom")):
        try:
            r = call("GET", path, ok404=True)
        except SystemExit as e:                 # token without that permission: say so, do not fail the deployment
            print(f"::warning::cannot verify R2 {what}: {str(e)[:120]}", file=sys.stderr); continue
        res = (r or {}).get("result") or {}
        if (what.startswith("managed") and res.get("enabled")) or (what.startswith("custom") and res.get("domains")):
            sys.exit(f"R2 bucket dslink-private has {what}: the bucket must stay private. Disable it in the dashboard (R2 > dslink-private > Settings) and run again.")
sub = call("GET", "/workers/subdomain")["result"]["subdomain"]
host = f"{NAME}.{sub}.workers.dev"

cfg = open(CONFIG).read()
cfg = re.sub(r"(?m)^\s*//.*$|(?<=\S)\s+//\s.*$", "", cfg)        # JSONC comments only: full-line, or " // text" after code (URLs have no space before //)
cfg = cfg.replace("REPLACE_WITH_D1_ID", d1["uuid"])
cfg = cfg.replace("dslink.example.workers.dev", host)
extra = [o.strip() for o in os.environ.get("DSLINK_EXTRA_ORIGINS", "").split(",") if o.strip()]       # e.g. https://my-dslink.netlify.app (exact origins only: they are allowed to call the API with credentials)
if extra:
    cfg = cfg.replace(f'"ORIGINS": "https://{host}"', '"ORIGINS": "' + ",".join([f"https://{host}"] + extra) + '"')
cfg = cfg.replace('"name": "dslink-cloud"', f'"name": "{NAME}"')
open("cloud/worker/wrangler.prod.jsonc", "w").write(cfg)

print(f"D1_ID={d1['uuid']}")
print(f"HOST={host}")
print(f"URL=https://{host}")
