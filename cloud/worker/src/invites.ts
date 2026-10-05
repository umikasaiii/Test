// Invites: "Simone ti invita a giocare a Mario Party DS" -> ACCETTA / RIFIUTA. Accepting creates the session
// (room, Player 1 = inviter who owns the game, Player 2 = invitee) and boots the container.
import type { Env, User } from "./env";
import { publicUser } from "./auth";
import { areFriends, notify, presenceOf } from "./friends";
import { HttpError, json, logEvent, now, randomId, readJson, str } from "./util";

const INVITE_TTL = 2 * 60_000;

export async function handleInvites(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/invites") {
    await env.DB.prepare("UPDATE invites SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").bind(now()).run();
    const rows = await env.DB.prepare(
      `SELECT i.id, i.status, i.session_id, i.expires_at, i.from_user, i.to_user, g.title, g.platform, u.username, u.display_name, u.avatar, u.created_at AS ucreated
       FROM invites i JOIN games g ON g.id = i.game_id JOIN users u ON u.id = CASE WHEN i.to_user = ?1 THEN i.from_user ELSE i.to_user END
       WHERE (i.to_user = ?1 OR i.from_user = ?1) AND i.status = 'pending' ORDER BY i.created_at DESC`).bind(user.id).all<any>();
    const map = (r: any) => ({ id: r.id, status: r.status, expiresAt: r.expires_at, game: { title: r.title, platform: r.platform },
      other: publicUser({ id: r.to_user === user.id ? r.from_user : r.to_user, username: r.username, display_name: r.display_name, avatar: r.avatar, created_at: r.ucreated }) });
    return json({ incoming: rows.results.filter((r) => r.to_user === user.id).map(map), outgoing: rows.results.filter((r) => r.from_user === user.id).map(map) });
  }

  if (m === "POST" && path === "/api/invites") {
    const b = await readJson(req);
    const friendId = str(b.friendId, "friendId", 1, 40), gameId = str(b.gameId, "gameId", 1, 40);
    if (!(await areFriends(env, user.id, friendId))) throw new HttpError(403, "not_friends");
    const game = await env.DB.prepare("SELECT id, title, platform FROM games WHERE id = ? AND user_id = ? AND status = 'ready'").bind(gameId, user.id).first<{ id: string; title: string; platform: string }>();
    if (!game) throw new HttpError(404, "game_not_found");
    const p = await presenceOf(env, friendId).status();
    if (p.status === "OFFLINE") throw new HttpError(409, "friend_offline");
    if (p.status === "IN_GAME") throw new HttpError(409, "friend_busy");
    await env.DB.prepare("UPDATE invites SET status = 'cancelled' WHERE from_user = ? AND to_user = ? AND status = 'pending'").bind(user.id, friendId).run();
    const id = randomId(12), t = now();
    await env.DB.prepare("INSERT INTO invites (id, from_user, to_user, game_id, status, created_at, expires_at) VALUES (?,?,?,?,'pending',?,?)").bind(id, user.id, friendId, game.id, t, t + INVITE_TTL).run();
    await notify(env, friendId, { t: "invite", id, from: publicUser(user), game: { title: game.title, platform: game.platform }, expiresAt: t + INVITE_TTL });
    return json({ id, expiresAt: t + INVITE_TTL }, 201);
  }

  let mm = path.match(/^\/api\/invites\/([\w-]+)\/respond$/);
  if (m === "POST" && mm) {
    const b = await readJson(req);
    const accept = b.accept === true;
    const inv = await env.DB.prepare("SELECT id, from_user, to_user, game_id, status, expires_at FROM invites WHERE id = ? AND to_user = ?").bind(mm[1], user.id).first<{ id: string; from_user: string; to_user: string; game_id: string; status: string; expires_at: number }>();
    if (!inv) throw new HttpError(404, "invite_not_found");
    if (inv.status !== "pending") throw new HttpError(409, "invite_not_pending");
    if (inv.expires_at < now()) { await env.DB.prepare("UPDATE invites SET status = 'expired' WHERE id = ?").bind(inv.id).run(); throw new HttpError(410, "invite_expired"); }
    if (!accept) {
      await env.DB.prepare("UPDATE invites SET status = 'refused' WHERE id = ?").bind(inv.id).run();
      await notify(env, inv.from_user, { t: "invite_update", id: inv.id, status: "refused", by: publicUser(user) });
      return json({ status: "refused" });
    }
    if ((await presenceOf(env, inv.from_user).status()).status === "IN_GAME") throw new HttpError(409, "friend_busy");
    const game = await env.DB.prepare("SELECT g.id, g.title, g.platform, u.display_name AS host_name FROM games g JOIN users u ON u.id = g.user_id WHERE g.id = ? AND g.status = 'ready'").bind(inv.game_id).first<{ id: string; title: string; platform: "nds" | "ps1"; host_name: string }>();
    if (!game) throw new HttpError(410, "game_gone");
    const sid = env.SESSION.newUniqueId().toString();
    const stub = env.SESSION.get(env.SESSION.idFromString(sid));
    await env.DB.prepare("INSERT INTO play_sessions (id, host_user, guest_user, game_title, platform, status, started_at) VALUES (?,?,?,?,?,'created',?)").bind(sid, inv.from_user, user.id, game.title, game.platform, now()).run();
    await env.DB.prepare("UPDATE invites SET status = 'accepted', session_id = ? WHERE id = ?").bind(sid, inv.id).run();
    await stub.init(sid, { hostId: inv.from_user, guestId: user.id, hostName: game.host_name, guestName: user.display_name, gameId: game.id, platform: game.platform, title: game.title });
    await notify(env, inv.from_user, { t: "invite_update", id: inv.id, status: "accepted", sessionId: sid, by: publicUser(user) });
    logEvent("invite_accepted", { platform: game.platform });
    return json({ status: "accepted", sessionId: sid });
  }

  mm = path.match(/^\/api\/invites\/([\w-]+)$/);
  if (m === "DELETE" && mm) {
    const r = await env.DB.prepare("UPDATE invites SET status = 'cancelled' WHERE id = ? AND from_user = ? AND status = 'pending' RETURNING to_user").bind(mm[1], user.id).first<{ to_user: string }>();
    if (!r) throw new HttpError(404, "invite_not_found");
    await notify(env, r.to_user, { t: "invite_update", id: mm[1], status: "cancelled" });
    return json({ ok: true });
  }
  return null;
}
