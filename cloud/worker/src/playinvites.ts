// "Invita a giocare": P1 picks a friend and a game from their library; the friend gets the invite in real time; ACCEPT puts both into the SAME signaling room (a Durable Object), where the
// existing PWA <-> PWA WebRTC flow takes over. No code, IP, port or SDP is ever typed. The room is created when the invite is sent (the host waits in it), is invite-only (its public 6-digit code
// can NOT take the invitee's seat) and is closed if the invite is refused, cancelled or expires. Only the friend whose invite it is ever receives the guest token.
import type { Env, User } from "./env";
import { publicUser } from "./auth";
import { areFriends, notify, presenceOf } from "./friends";
import { HttpError, json, logEvent, now, randomId, readJson, str } from "./util";
import { newCode } from "../../signal/room.mjs";
import { limit } from "./ratelimit";

export const INVITE_TTL = 2 * 60_000;
const roomStub = (env: Env, code: string) => env.SIGNAL.get(env.SIGNAL.idFromName("room:" + code));

async function blocked(env: Env, a: string, b: string) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1)").bind(a, b).first());
}

/** close the invite rooms between two users (a block, an unfriend) */
export async function cancelInvitesBetween(env: Env, a: string, b: string) {
  const rows = await env.DB.prepare("UPDATE room_invites SET status = 'cancelled' WHERE status = 'pending' AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)) RETURNING room_code").bind(a, b).all<{ room_code: string }>();
  for (const r of rows.results) { try { await roomStub(env, r.room_code).closeRoom("cancelled"); } catch { /* gone */ } }
}

async function expireOld(env: Env) {
  const rows = await env.DB.prepare("UPDATE room_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < ? RETURNING room_code, from_user, id").bind(now()).all<{ room_code: string; from_user: string; id: string }>();
  for (const r of rows.results) { try { await roomStub(env, r.room_code).closeRoom("expired"); } catch { /* gone */ } await notify(env, r.from_user, { t: "invite_update", id: r.id, status: "expired" }); }
}

interface Row { id: string; from_user: string; to_user: string; game_id: string; status: string; room_code: string; expires_at: number; title: string; platform: string; dl: number; username: string; display_name: string; avatar: string; ucreated: number }

export async function handlePlayInvites(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/play/invites") {
    await expireOld(env);
    const rows = await env.DB.prepare(
      `SELECT i.id, i.from_user, i.to_user, i.game_id, i.status, i.room_code, i.expires_at, g.title, g.platform, g.download_play_supported AS dl, u.username, u.display_name, u.avatar, u.created_at AS ucreated
       FROM room_invites i JOIN game_metadata g ON g.game_id = i.game_id JOIN users u ON u.id = CASE WHEN i.to_user = ?1 THEN i.from_user ELSE i.to_user END
       WHERE (i.to_user = ?1 OR i.from_user = ?1) AND i.status = 'pending' ORDER BY i.created_at DESC`).bind(user.id).all<Row>();
    const map = (r: Row) => ({ id: r.id, status: r.status, expiresAt: r.expires_at, game: { gameId: r.game_id, title: r.title, platform: r.platform, downloadPlaySupported: !!r.dl },
      other: publicUser({ id: r.to_user === user.id ? r.from_user : r.to_user, username: r.username, display_name: r.display_name, avatar: r.avatar, created_at: r.ucreated }) });
    return json({ incoming: rows.results.filter((r) => r.to_user === user.id).map(map), outgoing: rows.results.filter((r) => r.from_user === user.id).map(map) });
  }

  if (m === "POST" && path === "/api/play/invites") {
    limit(user.id, "invite", 20);                                            // every invite opens a room and rings a phone: 20 / 10 min / account
    const b = await readJson(req);
    const friendId = str(b.friendId, "friendId", 1, 40), gameId = str(b.gameId, "gameId", 3, 40);
    if (friendId === user.id) throw new HttpError(400, "cannot_invite_self");
    if (await blocked(env, user.id, friendId)) throw new HttpError(403, "not_friends");
    if (!(await areFriends(env, user.id, friendId))) throw new HttpError(403, "not_friends");
    // the inviter must have the game in their library (cloud metadata): the game is what is played, the file stays on the host's phone
    const game = await env.DB.prepare("SELECT g.game_id, g.title, g.platform, g.download_play_supported AS dl FROM library_entries e JOIN game_metadata g ON g.game_id = e.game_id WHERE e.user_id = ? AND e.game_id = ?").bind(user.id, gameId).first<{ game_id: string; title: string; platform: string; dl: number }>();
    if (!game) throw new HttpError(404, "game_not_found");
    const p = await presenceOf(env, friendId).status();
    if (p.status === "OFFLINE") throw new HttpError(409, "friend_offline");
    if (p.status === "IN_GAME") throw new HttpError(409, "friend_busy");
    // one open invite per pair: a new one replaces the old one (and closes its room)
    const old = await env.DB.prepare("UPDATE room_invites SET status = 'cancelled' WHERE from_user = ? AND to_user = ? AND status = 'pending' RETURNING room_code").bind(user.id, friendId).all<{ room_code: string }>();
    for (const o of old.results) { try { await roomStub(env, o.room_code).closeRoom("replaced"); } catch { /* gone */ } }
    let room: { code: string; hostToken: string; ttlSec: number } | null = null;
    for (let i = 0; i < 10 && !room; i++) { const code = newCode(); room = await roomStub(env, code).createInvite(code); }
    if (!room) throw new HttpError(503, "busy");
    const id = randomId(12), t = now();
    await env.DB.prepare("INSERT INTO room_invites (id, from_user, to_user, game_id, status, room_code, created_at, expires_at) VALUES (?,?,?,?,'pending',?,?,?)").bind(id, user.id, friendId, game.game_id, room.code, t, t + INVITE_TTL).run();
    await notify(env, friendId, { t: "invite", id, from: publicUser(user), game: { gameId: game.game_id, title: game.title, platform: game.platform, downloadPlaySupported: !!game.dl }, expiresAt: t + INVITE_TTL });
    logEvent("room_invite_sent", { platform: game.platform });
    // the HOST gets its token now and waits in the room; the guest token stays in the room until the friend accepts
    return json({ id, expiresAt: t + INVITE_TTL, room: { code: room.code, token: room.hostToken } }, 201);
  }

  let mm = path.match(/^\/api\/play\/invites\/([\w-]+)\/respond$/);
  if (m === "POST" && mm) {
    const b = await readJson(req);
    const inv = await env.DB.prepare("SELECT id, from_user, to_user, game_id, status, room_code, expires_at FROM room_invites WHERE id = ? AND to_user = ?").bind(mm[1], user.id).first<{ id: string; from_user: string; to_user: string; game_id: string; status: string; room_code: string; expires_at: number }>();
    if (!inv) throw new HttpError(404, "invite_not_found");            // not the recipient: same answer as "does not exist"
    if (inv.status !== "pending") throw new HttpError(409, "invite_not_pending");
    if (inv.expires_at < now()) { await expireOld(env); throw new HttpError(410, "invite_expired"); }
    if (await blocked(env, inv.from_user, user.id)) { await cancelInvitesBetween(env, inv.from_user, user.id); throw new HttpError(404, "invite_not_found"); }
    if (b.accept !== true) {
      await env.DB.prepare("UPDATE room_invites SET status = 'refused' WHERE id = ? AND status = 'pending'").bind(inv.id).run();
      try { await roomStub(env, inv.room_code).closeRoom("refused"); } catch { /* gone */ }
      await notify(env, inv.from_user, { t: "invite_update", id: inv.id, status: "refused", by: publicUser(user) });
      return json({ status: "refused" });
    }
    // accept exactly once: the conditional update decides a race between two devices of the same account
    const won = await env.DB.prepare("UPDATE room_invites SET status = 'accepted' WHERE id = ? AND status = 'pending'").bind(inv.id).run();
    if (!won.meta.changes) throw new HttpError(409, "invite_not_pending");
    const token = await roomStub(env, inv.room_code).claimGuest();
    if (!token) { await env.DB.prepare("UPDATE room_invites SET status = 'expired' WHERE id = ?").bind(inv.id).run(); throw new HttpError(410, "room_gone"); }
    await notify(env, inv.from_user, { t: "invite_update", id: inv.id, status: "accepted", by: publicUser(user) });
    return json({ status: "accepted", room: { code: inv.room_code, token }, gameId: inv.game_id });
  }

  mm = path.match(/^\/api\/play\/invites\/([\w-]+)$/);
  if (m === "DELETE" && mm) {
    const r = await env.DB.prepare("UPDATE room_invites SET status = 'cancelled' WHERE id = ? AND from_user = ? AND status = 'pending' RETURNING to_user, room_code").bind(mm[1], user.id).first<{ to_user: string; room_code: string }>();
    if (!r) throw new HttpError(404, "invite_not_found");
    try { await roomStub(env, r.room_code).closeRoom("cancelled"); } catch { /* gone */ }
    await notify(env, r.to_user, { t: "invite_update", id: mm[1], status: "cancelled" });
    return json({ ok: true });
  }
  return null;
}
