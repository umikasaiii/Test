// One Durable Object per game session: room, membership, player slots, authorisations, container lifecycle, cleanup.
//
// Authorisation model
//   * membership: only the two players may see the session or open its signalling WebSocket.
//   * content: the container (never a browser) receives a one-time-per-file ticket, valid for TICKET_TTL, that lets it read
//     exactly (a) the HOST's game files, (b) each slot's OWN BIOS/firmware, (c) the host's saves. Player 2 therefore never
//     receives the ROM: it is streamed from R2 into the container over an authenticated, ticketed request.
import { DurableObject } from "cloudflare:workers";
import type { Env, Platform } from "./env";
import { b64url, logEvent, now, randomBytes, sha256hex, timingSafeEqual } from "./util";

const TICKET_TTL = 10 * 60_000;
const LIFECYCLE_MS = 30_000;
const IDLE_END_MS = 2 * 60_000;          // nobody heartbeating -> end
const NEVER_JOINED_MS = 3 * 60_000;      // invite accepted but nobody opened the session
const MAX_SESSION_MS = 4 * 3600_000;

export interface SessionInit { hostId: string; guestId: string; hostName: string; guestName: string; gameId: string; platform: Platform; title: string }
export interface Manifest {
  sessionId: string; platform: Platform; title: string;
  files: { id: string; role: string; name: string; size: number }[];
  slots: { slot: 1 | 2; userId: string; name: string; system: string[]; hasContent: boolean }[];
  saves: { kind: string }[];
}
interface State extends SessionInit {
  id: string; status: "created" | "starting" | "running" | "ended"; createdAt: number; startedAt?: number; endedAt?: number;
  seen: Record<string, number>;          // userId -> last heartbeat
  tokens: [string, string];              // per-slot gateway tokens (secret, never sent to the other player)
  error?: string;
}

const slotOf = (s: State, uid: string): 1 | 2 | 0 => (uid === s.hostId ? 1 : uid === s.guestId ? 2 : 0);

export class GameSession extends DurableObject<Env> {
  private async st(): Promise<State | undefined> { return this.ctx.storage.get<State>("s"); }

  async init(sessionId: string, cfg: SessionInit): Promise<void> {
    if (await this.st()) return;
    const tokens: [string, string] = [b64url(randomBytes(18)), b64url(randomBytes(18))];
    const s: State = { ...cfg, id: sessionId, status: "starting", createdAt: now(), seen: {}, tokens };
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(now() + 100);   // boot the container from the alarm: it may take far longer than a request
    await this.setLeases(s, true);
  }

  /** what a MEMBER is allowed to know */
  async info(uid: string): Promise<null | { id: string; status: string; slot: 1 | 2; platform: Platform; title: string; hasCartridge: boolean; players: { slot: number; userId: string; displayName: string }[]; error?: string }> {
    const s = await this.st();
    if (!s) return null;
    const slot = slotOf(s, uid);
    if (!slot) return null;
    return { id: s.id, status: s.status, slot, platform: s.platform, title: s.title, hasCartridge: slot === 1, error: s.error,
      players: [{ slot: 1, userId: s.hostId, displayName: s.hostName }, { slot: 2, userId: s.guestId, displayName: s.guestName }] };
  }

  /** gateway credentials for a member (used by the Worker to open the signalling socket; never returned to browsers) */
  async gatewayAuth(uid: string): Promise<{ slot: 1 | 2; token: string } | null> {
    const s = await this.st();
    if (!s || s.status === "ended") return null;
    const slot = slotOf(s, uid);
    return slot ? { slot, token: s.tokens[slot - 1] } : null;
  }

  async heartbeat(uid: string): Promise<boolean> {
    const s = await this.st();
    if (!s || s.status === "ended" || !slotOf(s, uid)) return false;
    s.seen[uid] = now();
    await this.ctx.storage.put("s", s);
    return true;
  }

  async end(uid: string | null, reason = "ended"): Promise<boolean> {
    const s = await this.st();
    if (!s) return false;
    if (uid && !slotOf(s, uid)) return false;
    if (s.status === "ended") return true;
    s.status = "ended"; s.endedAt = now();
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("tickets");
    await this.destroyContainer();
    await this.setLeases(s, false);
    await this.env.DB.prepare("UPDATE play_sessions SET status = 'ended', ended_at = ? WHERE id = ?").bind(s.endedAt, s.id).run();
    logEvent("session_ended", { reason });
    return true;
  }

  // ----- content tickets (container-only) -----
  private async issueTicket(): Promise<string> {
    const ticket = b64url(randomBytes(24));
    await this.ctx.storage.put("tickets", { [await sha256hex(ticket)]: { exp: now() + TICKET_TTL, used: {} as Record<string, boolean> } });
    return ticket;
  }

  /** resolve an object the container asks for; null if the ticket or the request is not authorised */
  async authorize(ticket: string, what: { kind: "file"; id: string } | { kind: "system"; slot: 1 | 2; name: string } | { kind: "save"; save: string; write: boolean }): Promise<{ key: string } | null> {
    const s = await this.st();
    if (!s || s.status === "ended") return null;
    const tickets = (await this.ctx.storage.get<Record<string, { exp: number; used: Record<string, boolean> }>>("tickets")) ?? {};
    const h = await sha256hex(ticket);
    const t = Object.entries(tickets).find(([k]) => timingSafeEqual(new TextEncoder().encode(k), new TextEncoder().encode(h)))?.[1];
    if (!t || t.exp < now()) return null;
    const mark = what.kind === "file" ? "f:" + what.id : what.kind === "system" ? `s:${what.slot}:${what.name}` : "";
    if (mark) {
      if (t.used[mark]) return null;          // one-time per object
      t.used[mark] = true;
      await this.ctx.storage.put("tickets", { ...tickets, [h]: t });
    }
    if (what.kind === "file") {
      const f = await this.env.DB.prepare("SELECT r2_key FROM game_files WHERE id = ? AND game_id = ?").bind(what.id, s.gameId).first<{ r2_key: string }>();
      return f ? { key: f.r2_key } : null;   // always the HOST's game
    }
    if (what.kind === "system") {
      const uid = what.slot === 1 ? s.hostId : s.guestId;
      const f = await this.env.DB.prepare("SELECT r2_key FROM system_files WHERE user_id = ? AND platform = ? AND name = ?").bind(uid, s.platform, what.name).first<{ r2_key: string }>();
      return f ? { key: f.r2_key } : null;   // always the slot's OWN firmware
    }
    return { key: `u/${s.hostId}/saves/${s.gameId}/${what.save}` };
  }

  async recordSave(kind: string, size: number): Promise<void> {
    const s = await this.st();
    if (!s) return;
    await this.env.DB.prepare("INSERT INTO saves (id, user_id, game_id, kind, size, r2_key, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(game_id, kind) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at")
      .bind(b64url(randomBytes(8)), s.hostId, s.gameId, kind, size, `u/${s.hostId}/saves/${s.gameId}/${kind}`, now()).run();
  }

  async manifest(): Promise<Manifest | null> {
    const s = await this.st();
    if (!s) return null;
    const files = (await this.env.DB.prepare("SELECT id, role, name, size FROM game_files WHERE game_id = ? AND ok = 1 ORDER BY role").bind(s.gameId).all<{ id: string; role: string; name: string; size: number }>()).results;
    const sys = async (uid: string) => (await this.env.DB.prepare("SELECT name FROM system_files WHERE user_id = ? AND platform = ?").bind(uid, s.platform).all<{ name: string }>()).results.map((r) => r.name);
    const saves = (await this.env.DB.prepare("SELECT kind FROM saves WHERE game_id = ?").bind(s.gameId).all<{ kind: string }>()).results;
    return { sessionId: s.id, platform: s.platform, title: s.title, files, saves,
      slots: [{ slot: 1, userId: s.hostId, name: s.hostName, system: await sys(s.hostId), hasContent: true }, { slot: 2, userId: s.guestId, name: s.guestName, system: await sys(s.guestId), hasContent: false }] };
  }

  // ----- lifecycle -----
  async alarm(): Promise<void> {
    const s = await this.st();
    if (!s || s.status === "ended") return;
    if (s.status === "starting") await this.boot(s);
    const t = now();
    const last = Math.max(0, ...Object.values(s.seen));
    if (t - s.createdAt > MAX_SESSION_MS) { await this.end(null, "max_duration"); return; }
    if (!last && t - s.createdAt > NEVER_JOINED_MS) { await this.end(null, "never_joined"); return; }
    if (last && t - last > IDLE_END_MS) { await this.end(null, "idle"); return; }
    await this.setLeases(s, true);          // keep both players' IN_GAME lease alive while the session lives
    await this.ctx.storage.setAlarm(t + LIFECYCLE_MS);
  }

  private async boot(s: State): Promise<void> {
    if (!this.env.CONTAINER) { s.status = "running"; s.startedAt = now(); await this.ctx.storage.put("s", s); return; }   // tests / no container binding
    try {
      const { getContainer } = await import("@cloudflare/containers");
      const c = getContainer(this.env.CONTAINER as any, s.id);
      await c.startAndWaitForPorts();
      const ticket = await this.issueTicket();
      const manifest = await this.manifest();
      const r = await c.fetch(new Request("http://container/api/internal/session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.INTERNAL_TOKEN}` },
        body: JSON.stringify({ manifest, ticket, tokens: s.tokens, contentBase: `${this.env.ORIGINS.split(",")[0].trim()}/internal/sessions/${s.id}` }),
      }));
      if (!r.ok) throw new Error("container refused the session: " + r.status);
      s.status = "running"; s.startedAt = now();
    } catch (e) {
      s.error = "container_start_failed";
      logEvent("container_start_failed", { message: String((e as Error).message).slice(0, 120) });
      s.status = "ended"; s.endedAt = now();
      await this.env.DB.prepare("UPDATE play_sessions SET status = 'ended', ended_at = ? WHERE id = ?").bind(s.endedAt, s.id).run();
      await this.setLeases(s, false);
    }
    await this.ctx.storage.put("s", s);
  }

  private async destroyContainer(): Promise<void> {
    if (!this.env.CONTAINER) return;
    try {
      const { getContainer } = await import("@cloudflare/containers");
      const c = getContainer(this.env.CONTAINER as any, (await this.st())!.id);
      try {   // graceful: the gateway flushes the host's SRAM back to private storage and wipes the room before the container dies
        await c.fetch(new Request("http://container/api/internal/end", { method: "POST", headers: { authorization: `Bearer ${this.env.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(15_000) }));
      } catch { /* container already stopped */ }
      await c.destroy();
    } catch { /* already gone */ }
  }

  private async setLeases(s: State, on: boolean): Promise<void> {
    for (const uid of [s.hostId, s.guestId]) {
      try { await this.env.PRESENCE.get(this.env.PRESENCE.idFromName(uid)).setGame(on ? s.id : null); } catch { /* presence unreachable */ }
    }
  }
}
