// Blocks, user search and the friendship relation seen from one user: NONE | OUTGOING | INCOMING | FRIEND | BLOCKED (BLOCKED = *I* blocked them).
// Someone who blocked me is invisible to me: search never returns them, requests to them look like "user not found".
import { partyOnBlock } from "./party";
import type { Env, User } from "./env";
import { publicUser } from "./auth";
import { areFriends, notify } from "./friends";
import { cancelInvitesBetween } from "./playinvites";
import { HttpError, json, now, readJson, str } from "./util";

export type Relation = "NONE" | "OUTGOING" | "INCOMING" | "FRIEND" | "BLOCKED";

/** is there a block in either direction? */
export async function blockedEitherWay(env: Env, a: string, b: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1)").bind(a, b).first());
}

export async function relationOf(env: Env, me: string, other: string): Promise<Relation> {
  if (await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?").bind(me, other).first()) return "BLOCKED";
  if (await areFriends(env, me, other)) return "FRIEND";
  const r = await env.DB.prepare("SELECT from_user FROM friend_requests WHERE status = 'pending' AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)) LIMIT 1").bind(me, other).first<{ from_user: string }>();
  if (r) return r.from_user === me ? "OUTGOING" : "INCOMING";
  return "NONE";
}

async function byUsername(env: Env, username: string): Promise<User | null> {
  return env.DB.prepare("SELECT id, username, display_name, avatar, created_at FROM users WHERE username = ? AND status = 'active'").bind(username.toLowerCase()).first<User>();
}

export async function handleSocial(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/users/search") {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (q.length < 2) return json({ users: [] });
    const rows = await env.DB.prepare(
      `SELECT id, username, display_name, avatar, created_at FROM users
       WHERE status = 'active' AND id != ?1 AND username LIKE ?2 ESCAPE '\\'
         AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker = users.id AND blocked = ?1)
       ORDER BY (username = ?3) DESC, username LIMIT 10`).bind(user.id, q.replace(/_/g, "\\_") + "%", q).all<User>();
    return json({ users: await Promise.all(rows.results.map(async (u) => ({ ...publicUser(u), relation: await relationOf(env, user.id, u.id) }))) });
  }
  let mm = path.match(/^\/api\/users\/([a-z0-9_]{3,20})$/);
  if (m === "GET" && mm) {
    const u = await byUsername(env, mm[1]);
    if (!u || u.id === user.id || (await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?").bind(u.id, user.id).first())) throw new HttpError(404, "user_not_found");
    return json({ user: publicUser(u), relation: await relationOf(env, user.id, u.id) });
  }

  if (m === "GET" && path === "/api/blocks") {
    const rows = await env.DB.prepare("SELECT u.id, u.username, u.display_name, u.avatar, u.created_at, b.created_at AS since FROM blocks b JOIN users u ON u.id = b.blocked WHERE b.blocker = ? ORDER BY b.created_at DESC").bind(user.id).all<User & { since: number }>();
    return json({ blocked: rows.results.map((u) => ({ ...publicUser(u), since: u.since })) });
  }
  if (m === "POST" && path === "/api/blocks") {
    const b = await readJson(req);
    const target = await byUsername(env, str(b.username, "username", 3, 20));
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === user.id) throw new HttpError(400, "cannot_block_self");
    const [x, y] = user.id < target.id ? [user.id, target.id] : [target.id, user.id], t = now();
    // one atomic batch: the block, the end of the friendship and of every pending request between the two
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?,?,?)").bind(user.id, target.id, t),
      env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(x, y),
      env.DB.prepare("UPDATE friend_requests SET status = 'cancelled', updated_at = ?3 WHERE status = 'pending' AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1))").bind(user.id, target.id, t),
    ]);
    await cancelInvitesBetween(env, user.id, target.id);
    await partyOnBlock(env, user.id, target.id);                      // a blocked user leaves a shared party and pending party invites end
    await notify(env, target.id, { t: "friend_update", kind: "removed", user: publicUser(user) });   // they just see the friendship end: not that they were blocked
    return json({ ok: true, relation: "BLOCKED" }, 201);
  }
  mm = path.match(/^\/api\/blocks\/([\w-]+)$/);
  if (m === "DELETE" && mm) {
    const r = await env.DB.prepare("DELETE FROM blocks WHERE blocker = ? AND blocked = ?").bind(user.id, mm[1]).run();
    if (!r.meta.changes) throw new HttpError(404, "not_blocked");
    return json({ ok: true, relation: "NONE" });
  }
  return null;
}
