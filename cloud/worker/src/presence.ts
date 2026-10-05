// Presence: one Durable Object per user. Browsers keep a hibernatable WebSocket open and ping it every ~20 s.
//   ONLINE   = at least one live socket (any device, any tab)
//   IN_GAME  = a game session renewed the `inGame` lease recently (lease expires by itself: never "in game forever")
//   OFFLINE  = no live socket and no lease
// Closed tab / lost network: the socket closes, or (silent drop) the alarm sweeps sockets that missed pings for > STALE_MS.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type PresenceStatus = "ONLINE" | "IN_GAME" | "OFFLINE";
export const STALE_MS = 65_000;        // 3 missed pings
export const SWEEP_MS = 20_000;
export const GAME_LEASE_MS = 90_000;   // the session renews it every 30 s

interface Attach { lastSeen: number; device: string }

export class Presence extends DurableObject<Env> {
  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.READY_STATE_OPEN);
  }

  private async computeStatus(): Promise<PresenceStatus> {
    const until = (await this.ctx.storage.get<number>("gameUntil")) ?? 0;
    if (until > Date.now()) return "IN_GAME";
    return this.liveSockets().length > 0 ? "ONLINE" : "OFFLINE";
  }

  async status(): Promise<{ status: PresenceStatus; devices: number }> {
    await this.sweep();
    return { status: await this.computeStatus(), devices: this.liveSockets().length };
  }

  /** deliver an event to every connected device of this user (offline users pick things up via REST on connect) */
  async event(msg: Record<string, unknown>): Promise<number> {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const w of this.liveSockets()) { try { w.send(data); n++; } catch { /* closing */ } }
    return n;
  }

  async setGame(sessionId: string | null): Promise<void> {
    if (sessionId) await this.ctx.storage.put({ gameUntil: Date.now() + GAME_LEASE_MS, gameSession: sessionId });
    else await this.ctx.storage.delete(["gameUntil", "gameSession"]);
    await this.refresh();
    await this.scheduleSweep();
  }

  async purge(): Promise<void> {
    for (const w of this.ctx.getWebSockets()) { try { w.close(4001, "account deleted"); } catch { /* ignore */ } }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = req.headers.get("x-dslink-user");
    if (!uid) return new Response("forbidden", { status: 403 });          // only the Worker (after authentication) can reach this
    await this.ctx.storage.put("uid", uid);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const device = (req.headers.get("x-dslink-device") ?? "").slice(0, 60);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ lastSeen: Date.now(), device } satisfies Attach);
    server.send(JSON.stringify({ t: "hello", status: await this.computeStatus() }));
    await this.refresh();
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = (ws.deserializeAttachment() as Attach | null) ?? { lastSeen: 0, device: "" };
    ws.serializeAttachment({ ...a, lastSeen: Date.now() });
    if (typeof message === "string" && message.length < 256) {
      try { if (JSON.parse(message).t === "ping") ws.send('{"t":"pong"}'); } catch { /* ignore garbage */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "closed"); } catch { /* already closed */ }
    await this.refresh();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "error"); } catch { /* ignore */ }
    await this.refresh();
  }

  async alarm(): Promise<void> {
    await this.sweep();
    await this.refresh();
    await this.scheduleSweep();
  }

  private async sweep(): Promise<void> {
    const t = Date.now();
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment() as Attach | null;
      if (!a || t - a.lastSeen > STALE_MS) { try { w.close(4000, "timeout"); } catch { /* ignore */ } }
    }
    const until = (await this.ctx.storage.get<number>("gameUntil")) ?? 0;
    if (until && until <= t) await this.ctx.storage.delete(["gameUntil", "gameSession"]);
  }

  private async scheduleSweep(): Promise<void> {
    const until = (await this.ctx.storage.get<number>("gameUntil")) ?? 0;
    if (this.liveSockets().length > 0 || until > Date.now()) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  /** recompute the status and, on a change, tell the user's friends */
  private async refresh(): Promise<void> {
    const status = await this.computeStatus();
    const last = await this.ctx.storage.get<PresenceStatus>("last");
    if (status === last) return;
    await this.ctx.storage.put("last", status);
    const uid = await this.ctx.storage.get<string>("uid");
    if (!uid) return;
    const friends = await this.env.DB.prepare(
      "SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END AS fid FROM friendships WHERE user_a = ?1 OR user_b = ?1").bind(uid).all<{ fid: string }>();
    await Promise.all(friends.results.map((f) => this.env.PRESENCE.get(this.env.PRESENCE.idFromName(f.fid)).event({ t: "presence", userId: uid, status }).catch(() => 0)));
    // own devices learn the new status too (e.g. IN_GAME)
    await this.event({ t: "self_presence", status });
  }
}
