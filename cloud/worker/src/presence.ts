// Presence: one Durable Object per user. Browsers keep a hibernatable WebSocket open and ping it every ~20 s.
//   ONLINE   = at least one live socket (any device, any tab)
//   MENU     = a device reports it is in the DSLink menus ({t:"state", state:"menu"})
//   IN_GAME  = a device reports it is playing ({t:"state", state:"game", gameId}) - shown as "IN GAME · <title>" from the CATALOG title (never a file name) - or a hosted game session renewed the lease
//   OFFLINE  = no live socket and no lease
// Several devices of one account: the most active state wins (IN_GAME > MENU > ONLINE); each socket keeps its own state, so closing one device falls back to what the others report.
// Closed tab / lost network: the socket closes, or (silent drop) the alarm sweeps sockets that missed pings for > STALE_MS.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type PresenceStatus = "ONLINE" | "MENU" | "IN_GAME" | "OFFLINE";
export interface PresenceInfo { status: PresenceStatus; devices: number; game: { id: string; title: string } | null; party: boolean }   // party: in a Party Voice ("NEL PARTY"); the id is never shown to friends
export const STALE_MS = 65_000;        // 3 missed pings
export const SWEEP_MS = 20_000;
export const GAME_LEASE_MS = 90_000;   // the session renews it every 30 s

interface Attach { lastSeen: number; device: string; state?: "online" | "menu" | "game"; gameId?: string }

export class Presence extends DurableObject<Env> {
  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.READY_STATE_OPEN);
  }

  private async computeInfo(): Promise<PresenceInfo> {
    const live = this.liveSockets(), att = live.map((w) => (w.deserializeAttachment() as Attach | null) ?? { lastSeen: 0, device: "" });
    const until = (await this.ctx.storage.get<number>("gameUntil")) ?? 0, party = !!(await this.ctx.storage.get<string>("party"));
    const playing = att.find((a) => a.state === "game");
    if (until > Date.now() || playing) return { status: "IN_GAME", devices: live.length, game: playing?.gameId ? await this.gameInfo(playing.gameId) : null, party };
    if (live.length === 0) return { status: "OFFLINE", devices: 0, game: null, party };
    return { status: att.some((a) => a.state === "menu") ? "MENU" : "ONLINE", devices: live.length, game: null, party };
  }
  private async gameInfo(id: string): Promise<{ id: string; title: string } | null> {
    const r = await this.env.DB.prepare("SELECT game_id, title FROM game_metadata WHERE game_id = ?").bind(id).first<{ game_id: string; title: string }>();
    return r ? { id: r.game_id, title: r.title } : null;                // the title comes from the catalog; an unknown id shows no title, never a client-supplied string
  }
  private async computeStatus(): Promise<PresenceStatus> { return (await this.computeInfo()).status; }

  async status(): Promise<PresenceInfo> {
    await this.sweep();
    return this.computeInfo();
  }

  /** deliver an event to every connected device of this user (offline users pick things up via REST on connect) */
  async event(msg: Record<string, unknown>): Promise<number> {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const w of this.liveSockets()) { try { w.send(data); n++; } catch { /* closing */ } }
    return n;
  }

  /** the Worker tells this user's presence that they joined / left a party (only the fact is shown to friends) */
  async setParty(partyId: string | null): Promise<void> {
    if (partyId) await this.ctx.storage.put("party", partyId); else await this.ctx.storage.delete("party");
    await this.refresh();
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
    server.send(JSON.stringify({ t: "hello", ...(await this.computeInfo()) }));
    await this.refresh();
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = (ws.deserializeAttachment() as Attach | null) ?? { lastSeen: 0, device: "" };
    ws.serializeAttachment({ ...a, lastSeen: Date.now() });
    if (typeof message === "string" && message.length < 256) {
      try {
        const m = JSON.parse(message);
        if (m.t === "ping") ws.send('{"t":"pong"}');
        else if (m.t === "state" && ["online", "menu", "game"].includes(m.state)) {       // what this device is doing now
          const gameId = m.state === "game" && typeof m.gameId === "string" && /^[a-z0-9_-]{1,40}$/.test(m.gameId) ? m.gameId : undefined;
          ws.serializeAttachment({ ...a, lastSeen: Date.now(), state: m.state, gameId });
          await this.refresh();
        } else if (m.t === "bye") { try { ws.close(1000, "bye"); } catch { /* closing */ } await this.refresh(); }   // page hidden for good / signed out: do not wait for the timeout
      } catch { /* ignore garbage */ }
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
    const info = await this.computeInfo(), status = info.status, key = status + "|" + (info.game?.id ?? "") + "|" + (info.party ? "p" : "");
    const last = await this.ctx.storage.get<string>("last");
    if (key === last) return;
    await this.ctx.storage.put("last", key);
    const uid = await this.ctx.storage.get<string>("uid");
    if (!uid) return;
    const friends = await this.env.DB.prepare(
      "SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END AS fid FROM friendships WHERE user_a = ?1 OR user_b = ?1").bind(uid).all<{ fid: string }>();
    await Promise.all(friends.results.map((f) => this.env.PRESENCE.get(this.env.PRESENCE.idFromName(f.fid)).event({ t: "presence", userId: uid, status, game: info.game, party: info.party }).catch(() => 0)));
    // own devices learn the new status too (e.g. IN_GAME)
    await this.event({ t: "self_presence", status, game: info.game, party: info.party });
  }
}
