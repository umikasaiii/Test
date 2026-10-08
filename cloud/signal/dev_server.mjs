// DSLink PWA signaling server for development, tests and LAN use (Node >= 20, no dependencies). The production signaling is the same logic in the Worker (cloud/worker/src/signal.ts).
//   node cloud/signal/dev_server.mjs [--port 8788] [--static build/pwa] [--ttl-ms 600000] [--coi]
// With --static it also serves the built PWA (with the COOP/COEP headers that give the page SharedArrayBuffer). Serve it over HTTPS (or use localhost) for service workers.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Room, newCode, reply, CORS } from "./room.mjs";

export function createSignalHandler({ ttlMs = 600000, graceMs = 6000, staleMs = 25000, maxFailedPerMin = 30 } = {}) {
  const rooms = new Map(); const fails = new Map(); let sweeper = null;
  const stats = { created: 0, joined: 0, expired: 0, closed: 0, rejected: 0 };
  const sweep = () => { for (const [c, r] of rooms) { r.ping(); if (r.expired()) { r.close(); rooms.delete(c); stats.expired++; } else if (r.closed) { rooms.delete(c); stats.closed++; } } };
  sweeper = setInterval(sweep, 1000); sweeper.unref?.();
  const tooMany = (ip) => { const now = Date.now(), a = (fails.get(ip) || []).filter((t) => now - t < 60000); fails.set(ip, a); return a.length >= maxFailedPerMin; };
  const fail = (ip) => { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); stats.rejected++; };
  async function handle(req, ip = "local") {
    const url = new URL(req.url, "http://x"), p = url.pathname.replace(/^.*\/signal/, "/signal");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const body = async () => { try { return await req.json(); } catch { return {}; } };
    if (p === "/signal/health") return reply(200, { ok: true, rooms: rooms.size, ...stats });
    if (p === "/signal/create" && req.method === "POST") {
      let code; for (let i = 0; i < 20; i++) { code = newCode(); if (!rooms.has(code)) break; }
      const r = new Room(code, { ttlMs, graceMs, staleMs }); rooms.set(code, r); stats.created++;
      return reply(200, { code, token: r.tok.host, ttlSec: Math.round(ttlMs / 1000) });
    }
    if (p === "/signal/join" && req.method === "POST") {
      if (tooMany(ip)) return reply(429, { error: "locked" });
      const { code } = await body(); const r = typeof code === "string" ? rooms.get(code) : null;
      if (!r || r.expired()) { fail(ip); return reply(404, { error: "no_room" }); }
      const j = r.join(); if (j.error) { fail(ip); return reply(j.status, { error: j.error }); }
      stats.joined++; return reply(200, { token: j.token });
    }
    if (p === "/signal/events" && req.method === "GET") {
      const r = rooms.get(url.searchParams.get("code") || ""); const role = r && r.roleOf(url.searchParams.get("token"));
      if (!r || !role || r.expired()) return reply(404, { error: "no_room" });
      return r.subscribe(role) || reply(404, { error: "no_room" });
    }
    if (p === "/signal/send" && req.method === "POST") {
      const b = await body(); const r = rooms.get(b.code); const role = r && r.roleOf(b.token);
      if (!r || !role || r.expired()) return reply(404, { error: "no_room" });
      const res = r.send(role, b.data); return reply(res.status || 200, res.status ? { error: res.error } : res);
    }
    if (p === "/signal/state" && req.method === "POST") {
      const b = await body(); const r = rooms.get(b.code); const role = r && r.roleOf(b.token);
      if (!r || !role || r.expired()) return reply(404, { error: "no_room" });
      const res = r.setPhase(role, b.state); return reply(res.status || 200, res.status ? { error: res.error } : res);
    }
    if (p === "/signal/leave" && req.method === "POST") {
      const b = await body(); const r = rooms.get(b.code); const role = r && r.roleOf(b.token);
      if (r && role) r.leave(role, "left"); return reply(200, { ok: true });
    }
    return null;
  }
  return { handle, rooms, stats, close() { clearInterval(sweeper); for (const r of rooms.values()) r.close(); rooms.clear(); } };
}

/** adapt a Node request to the web-standard handler */
export function nodeAdapter(h) {
  return async (req, res) => {
    const url = new URL(req.url, "http://x"); if (!url.pathname.startsWith("/signal")) return false;
    const chunks = []; for await (const c of req) chunks.push(c);
    const hasBody = chunks.length && req.method !== "GET";
    const wreq = new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined });
    const r = await h.handle(wreq, req.socket.remoteAddress);
    if (!r) return false;
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) {
      const reader = r.body.getReader(); res.on("close", () => reader.cancel().catch(() => {}));
      (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); } } catch { /* client gone */ } res.end(); })();
    } else res.end();
    return true;
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const port = Number(arg("--port", 8788)), staticDir = arg("--static", ""), coi = process.argv.includes("--coi") || !!staticDir;
  const sig = createSignalHandler({ ttlMs: Number(arg("--ttl-ms", 600000)) }), adapter = nodeAdapter(sig);
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  http.createServer(async (req, res) => {
    if (await adapter(req, res)) return;
    if (!staticDir) { res.writeHead(404).end(); return; }
    let p = new URL(req.url, "http://x").pathname; if (p.endsWith("/")) p += "index.html";
    const f = path.join(staticDir, p); if (!f.startsWith(path.resolve(staticDir))) { res.writeHead(403).end(); return; }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404).end(); return; } res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store", ...(coi ? { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } : {}) }); res.end(d); });
  }).listen(port, () => console.log(`DSLink signaling on :${port}${staticDir ? " + PWA from " + staticDir : ""}`));
}
