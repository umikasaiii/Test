#!/usr/bin/env python3
"""Idempotent Cloudflare provisioning for DSLink (run by .github/workflows/deploy.yml; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).

Creates (only if missing): D1 database `dslink` and, when the account has R2, the PRIVATE R2 bucket `dslink-private` (verifying it has no public access). Writes
cloud/worker/wrangler.prod.jsonc (no secrets inside) with the real D1 id and the account's workers.dev origin. Secrets are set with `wrangler secret put` by the workflow.

R2 is OPTIONAL. If it is not enabled on the account (Cloudflare error 10042 "Please enable R2", or the token cannot use R2) or DSLINK_R2=off, the deployment does NOT fail:
the STORE binding is left out of wrangler.prod.jsonc and the Worker, D1, Durable Objects and the PWA are deployed without private Cloud storage (files and saves stay on the devices).
Prints `KEY=value` lines for the workflow (never secret values), including R2_ENABLED=true|false. Stdlib only.
"""
import json, os, re, sys, urllib.request, urllib.error

TOKEN, ACC = os.environ.get("CLOUDFLARE_API_TOKEN"), os.environ.get("CLOUDFLARE_ACCOUNT_ID")
NAME = os.environ.get("DSLINK_WORKER_NAME", "dslink-cloud")
if not TOKEN or not ACC:
    sys.exit("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required")
API = os.environ.get("CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4").rstrip("/") + f"/accounts/{ACC}"      # CLOUDFLARE_API_BASE: tests only


class CfError(Exception):
    def __init__(self, method, path, status, codes, text):
        super().__init__(f"{method} {path} -> HTTP {status}: {text[:300]}")
        self.status, self.codes = status, codes


def call(method, path, body=None, ok404=False, soft=False):
    """soft=True raises CfError instead of exiting (used for R2, which is optional)."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    for attempt in (1, 2, 3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if ok404 and e.code == 404 and "10042" not in text:
                return None
            if e.code >= 500 and attempt < 3:
                continue
            try:
                codes = [int(x.get("code")) for x in (json.loads(text).get("errors") or []) if str(x.get("code", "")).isdigit()]
            except Exception:
                codes = []
            if soft:
                raise CfError(method, path, e.code, codes, text)
            sys.exit(f"{method} {path} -> HTTP {e.code}: {text[:300]}")
        except urllib.error.URLError as e:
            if attempt == 3:
                sys.exit(f"{method} {path} -> {e.reason}")

# D1
found = call("GET", "/d1/database?name=dslink")["result"]
d1 = next((d for d in found if d["name"] == "dslink"), None) or call("POST", "/d1/database", {"name": "dslink"})["result"]
CONFIG = os.environ.get("DSLINK_WRANGLER_CONFIG", "cloud/worker/wrangler.jsonc")
# R2 (OPTIONAL): ONE private bucket for the users' own files and saves (the Worker's STORE binding). Private = no r.dev public URL and no custom domain; this script never enables either, and checks it.
# Not enabled on the account (10042 "Please enable R2" needs a payment method), no R2 permission on the token, or DSLINK_R2=off: carry on WITHOUT the binding (R2_ENABLED=false).
R2_ENABLED, R2_REASON = False, "not_in_config"
if "r2_buckets" in open(CONFIG).read():
    if os.environ.get("DSLINK_R2", "").lower() in ("off", "false", "0", "no"):
        R2_REASON = "disabled_by_DSLINK_R2"
    else:
        try:
            if call("GET", "/r2/buckets/dslink-private", ok404=True, soft=True) is None:
                call("POST", "/r2/buckets", {"name": "dslink-private"}, soft=True)
            R2_ENABLED, R2_REASON = True, "ok"
        except CfError as e:
            R2_REASON = "not_enabled_10042" if 10042 in e.codes else f"unavailable_http_{e.status}"
            print(f"::notice::R2 is not available on this account ({R2_REASON}): deploying without private Cloud storage. Files and saves stay on the devices; everything else works.", file=sys.stderr)
    if R2_ENABLED:
        for what, path in (("managed r2.dev public access", "/r2/buckets/dslink-private/domains/managed"), ("custom domains", "/r2/buckets/dslink-private/domains/custom")):
            try:
                r = call("GET", path, ok404=True, soft=True)
            except CfError as e:                 # token without that permission: say so, do not fail the deployment
                print(f"::warning::cannot verify R2 {what}: HTTP {e.status}", file=sys.stderr); continue
            res = (r or {}).get("result") or {}
            if (what.startswith("managed") and res.get("enabled")) or (what.startswith("custom") and res.get("domains")):
                sys.exit(f"R2 bucket dslink-private has {what}: the bucket must stay private. Disable it in the dashboard (R2 > dslink-private > Settings) and run again.")
sub = call("GET", "/workers/subdomain")["result"]["subdomain"]
host = f"{NAME}.{sub}.workers.dev"

cfg = open(CONFIG).read()
cfg = re.sub(r"(?m)^\s*//.*$|(?<=\S)\s+//\s.*$", "", cfg)        # JSONC comments only: full-line, or " // text" after code (URLs have no space before //)
if not R2_ENABLED:                                                  # no STORE binding at all: the Worker answers STORAGE_NOT_CONFIGURED on the file routes
    cfg = re.sub(r'"r2_buckets"\s*:\s*\[[^\]]*\]\s*,?', "", cfg)
cfg = cfg.replace("REPLACE_WITH_D1_ID", d1["uuid"])
cfg = cfg.replace("dslink.example.workers.dev", host)
extra = [o.strip() for o in os.environ.get("DSLINK_EXTRA_ORIGINS", "").split(",") if o.strip()]       # e.g. https://my-dslink.netlify.app (exact origins only: they are allowed to call the API with credentials)
if extra:
    cfg = cfg.replace(f'"ORIGINS": "https://{host}"', '"ORIGINS": "' + ",".join([f"https://{host}"] + extra) + '"')
cfg = cfg.replace('"name": "dslink-cloud"', f'"name": "{NAME}"')
try:                                                                # the generated file must be valid JSONC (trailing commas are allowed by wrangler)
    json.loads(re.sub(r",(\s*[}\]])", r"\1", cfg))
except ValueError as e:
    sys.exit(f"generated wrangler.prod.jsonc is not valid: {e}")
if R2_ENABLED and '"r2_buckets"' not in cfg:
    sys.exit("R2 is enabled but the config has no STORE binding")
open(os.environ.get("DSLINK_PROD_CONFIG", "cloud/worker/wrangler.prod.jsonc"), "w").write(cfg)

print(f"D1_ID={d1['uuid']}")
print(f"HOST={host}")
print(f"URL=https://{host}")
print(f"R2_ENABLED={'true' if R2_ENABLED else 'false'}")
print(f"R2_REASON={R2_REASON}")
