import type { Env, User } from "./env";
import { publicUser } from "./auth";
import { HttpError, json, now, randomId, readJson, str } from "./util";

export const presenceOf = (env: Env, userId: string) => env.PRESENCE.get(env.PRESENCE.idFromName(userId));
export const notify = (env: Env, userId: string, msg: Record<string, unknown>) => presenceOf(env, userId).event(msg).catch(() => 0);

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

export async function areFriends(env: Env, a: string, b: string): Promise<boolean> {
  const [x, y] = pair(a, b);
  return !!(await env.DB.prepare("SELECT 1 AS x FROM friendships WHERE user_a = ? AND user_b = ?").bind(x, y).first());
}

async function makeFriends(env: Env, a: string, b: string) {
  const [x, y] = pair(a, b);
  await env.DB.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?,?,?)").bind(x, y, now()).run();
}

async function listFriends(env: Env, user: User) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.created_at FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
     WHERE f.user_a = ?1 OR f.user_b = ?1 ORDER BY u.display_name COLLATE NOCASE`).bind(user.id).all<User>();
  return Promise.all(rows.results.map(async (u) => {
    let status = "OFFLINE";
    try { status = (await presenceOf(env, u.id).status()).status; } catch { /* presence unreachable: treat as offline, never as online */ }
    return { ...publicUser(u), status };
  }));
}

export async function handleFriends(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/friends") return json({ friends: await listFriends(env, user) });

  if (m === "GET" && path === "/api/friends/requests") {
    const incoming = await env.DB.prepare(
      `SELECT r.id, r.created_at, u.id AS uid, u.username, u.display_name, u.avatar, u.created_at AS ucreated FROM friend_requests r JOIN users u ON u.id = r.from_user
       WHERE r.to_user = ? AND r.status = 'pending' ORDER BY r.created_at DESC`).bind(user.id).all<any>();
    const outgoing = await env.DB.prepare(
      `SELECT r.id, r.created_at, u.id AS uid, u.username, u.display_name, u.avatar, u.created_at AS ucreated FROM friend_requests r JOIN users u ON u.id = r.to_user
       WHERE r.from_user = ? AND r.status = 'pending' ORDER BY r.created_at DESC`).bind(user.id).all<any>();
    const map = (r: any) => ({ id: r.id, createdAt: r.created_at, user: publicUser({ id: r.uid, username: r.username, display_name: r.display_name, avatar: r.avatar, created_at: r.ucreated }) });
    return json({ incoming: incoming.results.map(map), outgoing: outgoing.results.map(map) });
  }

  if (m === "POST" && path === "/api/friends/requests") {
    const b = await readJson(req);
    const username = str(b.username, "username", 3, 20).toLowerCase();
    const target = await env.DB.prepare("SELECT id, username, display_name, avatar, created_at FROM users WHERE username = ?").bind(username).first<User>();
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === user.id) throw new HttpError(400, "cannot_add_self");
    if (await areFriends(env, user.id, target.id)) throw new HttpError(409, "already_friends");
    const t = now();
    // the other side already asked us: asking back simply accepts
    const reverse = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'").bind(target.id, user.id).first<{ id: string }>();
    if (reverse) {
      await env.DB.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?").bind(t, reverse.id).run();
      await makeFriends(env, user.id, target.id);
      await notify(env, target.id, { t: "friend_update", kind: "accepted", user: publicUser(user) });
      return json({ status: "accepted", friend: publicUser(target) }, 200);
    }
    const id = randomId(12);
    try {
      await env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)").bind(id, user.id, target.id, t, t).run();
    } catch { throw new HttpError(409, "request_already_pending"); }
    await notify(env, target.id, { t: "friend_request", id, user: publicUser(user) });
    return json({ status: "pending", id }, 201);
  }

  let mm = path.match(/^\/api\/friends\/requests\/([\w-]+)\/(accept|refuse)$/);
  if (m === "POST" && mm) {
    const r = await env.DB.prepare("SELECT id, from_user, to_user, status FROM friend_requests WHERE id = ?").bind(mm[1]).first<{ id: string; from_user: string; to_user: string; status: string }>();
    if (!r || r.to_user !== user.id) throw new HttpError(404, "request_not_found");   // not the recipient: indistinguishable from "does not exist"
    if (r.status !== "pending") throw new HttpError(409, "request_not_pending");
    const accept = mm[2] === "accept";
    await env.DB.prepare("UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?").bind(accept ? "accepted" : "refused", now(), r.id).run();
    if (accept) await makeFriends(env, r.from_user, r.to_user);
    await notify(env, r.from_user, { t: "friend_update", kind: accept ? "accepted" : "refused", user: publicUser(user) });
    return json({ status: accept ? "accepted" : "refused" });
  }

  mm = path.match(/^\/api\/friends\/requests\/([\w-]+)$/);
  if (m === "DELETE" && mm) {
    const r = await env.DB.prepare("UPDATE friend_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND from_user = ? AND status = 'pending' RETURNING to_user").bind(now(), mm[1], user.id).first<{ to_user: string }>();
    if (!r) throw new HttpError(404, "request_not_found");
    await notify(env, r.to_user, { t: "friend_update", kind: "cancelled", user: publicUser(user) });
    return json({ ok: true });
  }

  mm = path.match(/^\/api\/friends\/([\w-]+)$/);
  if (m === "DELETE" && mm) {
    const [x, y] = pair(user.id, mm[1]);
    const res = await env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(x, y).run();
    if (!res.meta.changes) throw new HttpError(404, "not_friends");
    // pending invites between the two are void
    await env.DB.prepare("UPDATE invites SET status = 'cancelled' WHERE status = 'pending' AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1))").bind(user.id, mm[1]).run();
    await notify(env, mm[1], { t: "friend_update", kind: "removed", user: publicUser(user) });
    return json({ ok: true });
  }
  return null;
}
