// Party Voice signaling relay: one Durable Object per party. It carries ONLY small JSON between members (WebRTC offer/answer/ICE, mic state, roster events).
// The voice itself is WebRTC audio straight between the phones (or through TURN): it never touches this object, the Worker or D1, and nothing is recorded or stored.
// Membership is decided by the Worker (D1) before a socket is forwarded here; a member removed from D1 gets its socket closed through kick().
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

interface Attach { uid: string; muted: boolean; since: number; win: number; n: number }
const MAX_MSG = 16 * 1024, RATE_PER_S = 80;

export class PartyRoom extends DurableObject<Env> {
  private socks(uid?: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.READY_STATE_OPEN && (!uid || (w.deserializeAttachment() as Attach | null)?.uid === uid));
  }
  private roster() {
    return this.socks().map((w) => w.deserializeAttachment() as Attach).map((a) => ({ userId: a.uid, muted: a.muted }));
  }
  private send(w: WebSocket, m: unknown) { try { w.send(JSON.stringify(m)); } catch { /* closing */ } }
  private broadcast(m: unknown, except?: string) {
    for (const w of this.socks()) { const a = w.deserializeAttachment() as Attach; if (a.uid !== except) this.send(w, m); }
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = req.headers.get("x-dslink-user");
    if (!uid) return new Response("forbidden", { status: 403 });          // only the Worker, after authentication and a membership check, can reach this
    for (const w of this.socks(uid)) { try { w.close(4004, "replaced"); } catch { /* gone */ } }       // one live connection per member: a newer device/tab replaces the older
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ uid, muted: false, since: Date.now(), win: Date.now(), n: 0 } satisfies Attach);
    this.send(pair[1], { t: "roster", you: uid, members: this.roster() });
    this.broadcast({ t: "peer_joined", userId: uid }, uid);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null; if (!a) return;
    const t = Date.now();
    if (t - a.win > 1000) { a.win = t; a.n = 0; } a.n++;
    if (a.n > RATE_PER_S) { try { ws.close(4008, "too fast"); } catch { /* gone */ } return; }
    ws.serializeAttachment(a);
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    let m: any; try { m = JSON.parse(message); } catch { return; }
    if (m.t === "ping") this.send(ws, { t: "pong" });
    else if (m.t === "state" && typeof m.muted === "boolean") {                       // mic on/off: shown to the others
      ws.serializeAttachment({ ...a, muted: m.muted });
      this.broadcast({ t: "state", userId: a.uid, muted: m.muted }, a.uid);
    } else if (m.t === "signal" && typeof m.to === "string" && m.to !== a.uid && m.data && typeof m.data === "object") {
      for (const w of this.socks(m.to)) this.send(w, { t: "signal", from: a.uid, data: m.data });      // members only: a socket exists only for a member
    }
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    try { ws.close(code === 1005 ? 1000 : code, "closed"); } catch { /* already closed */ }
    if (a && this.socks(a.uid).length === 0) this.broadcast({ t: "peer_left", userId: a.uid }, a.uid);
  }
  async webSocketError(ws: WebSocket): Promise<void> { try { ws.close(1011, "error"); } catch { /* ignore */ } }

  /** the Worker removed a member (kick / block / leave): drop its socket and tell the others */
  async kick(uid: string, reason = "removed"): Promise<void> {
    for (const w of this.socks(uid)) { try { w.close(4003, reason); } catch { /* gone */ } }
    this.broadcast({ t: "peer_left", userId: uid, reason }, uid);
  }
  /** membership / owner changed: members refresh their view */
  async changed(): Promise<void> { this.broadcast({ t: "party_update" }); }
  async connected(): Promise<string[]> { return this.socks().map((w) => (w.deserializeAttachment() as Attach).uid); }
}
