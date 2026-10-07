// PWA <-> PWA signaling (Distributed multiplayer, Phase 3): the minimum a browser needs to open a WebRTC connection to another browser. One Durable Object per 6-digit code holds one
// EPHEMERAL room (host + one guest) and relays offer / answer / ICE messages. It stores nothing (no ROM, save, BIOS, firmware, account, log of the traffic), expires on its own and
// closes when the host leaves. The room logic is shared with the Node development server (cloud/signal/room.mjs), the HTTP contract is tested by cloud/tests/signal_contract.mjs.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CORS, Room, newCode, reply } from "../../signal/room.mjs";

const TTL_MS = 10 * 60_000;

export class SignalRoom extends DurableObject<Env> {
  private room: Room | null = null;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), p = url.pathname;
    const body = async () => { try { return (await req.json()) as any; } catch { return {}; } };
    if (p === "/create") {
      if (this.room && !this.room.expired()) return reply(409, { error: "exists" });
      const code = url.searchParams.get("code")!;
      this.room = new Room(code, { ttlMs: TTL_MS });
      await this.ctx.storage.setAlarm(Date.now() + 5_000);           // the only thing written: the next heartbeat (the room's own idle TTL decides when it disappears)
      return reply(200, { code, token: this.room.tok.host, ttlSec: TTL_MS / 1000 });
    }
    const r = this.room;
    if (!r || r.expired()) return reply(404, { error: "no_room" });
    if (p === "/join") { const j = r.join(); if ("error" in j) return reply(j.status, { error: j.error }); return reply(200, { token: j.token }); }
    if (p === "/events") {
      const role = r.roleOf(url.searchParams.get("token"));
      if (!role) return reply(404, { error: "no_room" });
      return r.subscribe(role) ?? reply(404, { error: "no_room" });
    }
    if (p === "/send") { const b = await body(); const role = r.roleOf(b.token); if (!role) return reply(404, { error: "no_room" }); const res = r.send(role, b.data); return "error" in res ? reply(res.status, { error: res.error }) : reply(200, res); }
    if (p === "/leave") { const b = await body(); const role = r.roleOf(b.token); if (role) r.leave(role, "left"); if (r.closed) { this.room = null; await this.ctx.storage.deleteAll(); } return reply(200, { ok: true }); }
    return reply(404, { error: "not_found" });
  }

  async alarm(): Promise<void> {
    if (this.room && !this.room.expired()) { this.room.ping(); await this.ctx.storage.setAlarm(Date.now() + 5_000); return; }   // heartbeat for open streams while the room lives (a failed write = that page is gone)
    this.room?.close(); this.room = null; await this.ctx.storage.deleteAll();
  }
}

const fails = new Map<string, number[]>();
const limited = (ip: string) => { const now = Date.now(), a = (fails.get(ip) ?? []).filter((t) => now - t < 60_000); fails.set(ip, a); return a.length >= 30; };
const failed = (ip: string) => { const a = fails.get(ip) ?? []; a.push(Date.now()); fails.set(ip, a); };

export async function handleSignal(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url), p = url.pathname.replace(/^\/signal/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const stubFor = (code: string) => env.SIGNAL.get(env.SIGNAL.idFromName("room:" + code));
  if (p === "/health") return reply(200, { ok: true });
  if (p === "/create" && req.method === "POST") {
    for (let i = 0; i < 20; i++) {
      const code = newCode(); const res = await stubFor(code).fetch(new Request("http://do/create?code=" + code, { method: "POST" }));
      if (res.status === 200) return new Response(res.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
    }
    return reply(503, { error: "busy" });
  }
  let code = url.searchParams.get("code") ?? "", payload: any = null;
  if (req.method === "POST") { try { payload = await req.json(); } catch { payload = {}; } code = String(payload.code ?? code); }
  if (!/^\d{6}$/.test(code)) { if (p === "/join") failed(ip); return reply(404, { error: "no_room" }); }
  if (p === "/join") { if (limited(ip)) return reply(429, { error: "locked" }); }
  if (!["/join", "/events", "/send", "/leave"].includes(p)) return reply(404, { error: "not_found" });
  const forward = req.method === "GET" ? new Request("http://do" + p + url.search) : new Request("http://do" + p, { method: "POST", body: JSON.stringify(payload) });
  const res = await stubFor(code).fetch(forward);
  if (p === "/join" && res.status !== 200) failed(ip);
  const h = new Headers(res.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
