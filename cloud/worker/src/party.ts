// Party Voice: membership, invites, owner/kick and the signaling socket. NOTHING of the voice passes here (see partyroom.ts): the Cloud knows only who is in a party and who is connected.
// All authorisation is server side: only members connect, only friends are invited, a blocked user can neither invite, nor be invited, nor stay in a shared party. Pure D1 rules, tested.
import type { Env, User } from "./env";
import { publicUser } from "./auth";
import { areFriends, notify, presenceOf } from "./friends";
import { blockedEitherWay } from "./social";
import { HttpError, json, now, randomId, readJson, str } from "./util";
import { limit } from "./ratelimit";

export const PARTY_MAX = 8, PARTY_INVITE_TTL = 5 * 60_000, PARTY_IDLE_MS = 12 * 3600_000;
export const partyStub = (env: Env, id: string) => env.PARTY.get(env.PARTY.idFromName(id));

interface MemberRow { id: string; username: string; display_name: string; avatar: string; created_at: number; joined_at: number }

async function gc(env: Env) {
  const old = await env.DB.prepare("SELECT id FROM parties WHERE last_active < ? LIMIT 20").bind(now() - PARTY_IDLE_MS).all<{ id: string }>();
  for (const p of old.results) {
    const ms = await env.DB.prepare("SELECT user_id FROM party_members WHERE party_id = ?").bind(p.id).all<{ user_id: string }>();
    await env.DB.prepare("DELETE FROM parties WHERE id = ?").bind(p.id).run();
    for (const m of ms.results) { await presenceOf(env, m.user_id).setParty(null).catch(() => {}); await partyStub(env, p.id).kick(m.user_id, "expired").catch(() => {}); }
  }
}

export async function partyOf(env: Env, userId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT party_id FROM party_members WHERE user_id = ?").bind(userId).first<{ party_id: string }>())?.party_id ?? null;
}

async function snapshot(env: Env, partyId: string) {
  const p = await env.DB.prepare("SELECT id, owner, created_at, max_members FROM parties WHERE id = ?").bind(partyId).first<{ id: string; owner: string; created_at: number; max_members: number }>();
  if (!p) return null;
  const rows = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.created_at, m.joined_at FROM party_members m JOIN users u ON u.id = m.user_id WHERE m.party_id = ? ORDER BY m.joined_at, u.id`).bind(partyId).all<MemberRow>();
  let live: string[] = []; try { live = await partyStub(env, partyId).connected(); } catch { /* DO unreachable: nobody shown as connected */ }
  return { id: p.id, owner: p.owner, createdAt: p.created_at, max: p.max_members,
    members: rows.results.map((r) => ({ ...publicUser({ id: r.id, username: r.username, display_name: r.display_name, avatar: r.avatar, created_at: r.created_at }), role: r.id === p.owner ? "owner" : "member", joinedAt: r.joined_at, connected: live.includes(r.id) })) };
}

async function touch(env: Env, partyId: string) { await env.DB.prepare("UPDATE parties SET last_active = ? WHERE id = ?").bind(now(), partyId).run(); }

async function tellMembers(env: Env, partyId: string, msg: Record<string, unknown>, except?: string) {
  const ms = await env.DB.prepare("SELECT user_id FROM party_members WHERE party_id = ?").bind(partyId).all<{ user_id: string }>();
  await Promise.all(ms.results.filter((m) => m.user_id !== except).map((m) => notify(env, m.user_id, msg)));
  await partyStub(env, partyId).changed().catch(() => {});
}

/** remove `userId` from its party (leave / kick / block). The owner leaving hands the party to the longest-standing member; an empty party disappears. */
export async function removeMember(env: Env, partyId: string, userId: string, reason: string) {
  await env.DB.prepare("DELETE FROM party_members WHERE party_id = ? AND user_id = ?").bind(partyId, userId).run();
  await presenceOf(env, userId).setParty(null).catch(() => {});
  await partyStub(env, partyId).kick(userId, reason).catch(() => {});
  const p = await env.DB.prepare("SELECT owner FROM parties WHERE id = ?").bind(partyId).first<{ owner: string }>();
  const next = await env.DB.prepare("SELECT user_id FROM party_members WHERE party_id = ? ORDER BY joined_at, user_id LIMIT 1").bind(partyId).first<{ user_id: string }>();
  if (!next) { await env.DB.prepare("DELETE FROM parties WHERE id = ?").bind(partyId).run(); return; }
  if (p && p.owner === userId) await env.DB.prepare("UPDATE parties SET owner = ? WHERE id = ?").bind(next.user_id, partyId).run();
  await tellMembers(env, partyId, { t: "party_update", reason });
}

/** called when a block is created: nobody stays in a party with someone who blocked them (the blocked one leaves), and pending party invites between the two end */
export async function partyOnBlock(env: Env, blocker: string, blocked: string) {
  await cancelPartyInvitesBetween(env, blocker, blocked);
  const a = await partyOf(env, blocker), b = await partyOf(env, blocked);
  if (a && a === b) { await notify(env, blocked, { t: "party_kicked", reason: "blocked" }); await removeMember(env, a, blocked, "blocked"); }
}
export async function cancelPartyInvitesBetween(env: Env, a: string, b: string) {
  const rows = await env.DB.prepare("SELECT id, from_user, to_user FROM party_invites WHERE status = 'pending' AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1))").bind(a, b).all<{ id: string; from_user: string; to_user: string }>();
  for (const r of rows.results) {
    await env.DB.prepare("UPDATE party_invites SET status = 'cancelled' WHERE id = ?").bind(r.id).run();
    await notify(env, r.to_user, { t: "party_invite_update", id: r.id, status: "cancelled" }); await notify(env, r.from_user, { t: "party_invite_update", id: r.id, status: "cancelled" });
  }
}

export async function handleParty(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  if (!path.startsWith("/api/party")) return null;
  const m = req.method;
  await gc(env);

  if (path === "/api/party" && m === "POST") {                                        // CREA PARTY
    limit(user.id, "party-create", 12);
    if (await partyOf(env, user.id)) throw new HttpError(409, "already_in_party");
    const id = randomId(12), t = now();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO parties (id, owner, created_at, last_active, max_members) VALUES (?,?,?,?,?)").bind(id, user.id, t, t, PARTY_MAX),
        env.DB.prepare("INSERT INTO party_members (party_id, user_id, joined_at) VALUES (?,?,?)").bind(id, user.id, t),
      ]);
    } catch { throw new HttpError(409, "already_in_party"); }
    await presenceOf(env, user.id).setParty(id).catch(() => {});
    return json({ party: await snapshot(env, id) }, 201);
  }
  if (path === "/api/party/me" && m === "GET") {
    const id = await partyOf(env, user.id);
    return json({ party: id ? await snapshot(env, id) : null });
  }
  if (path === "/api/party/leave" && m === "POST") {                                  // ESCI
    const id = await partyOf(env, user.id); if (!id) throw new HttpError(404, "not_in_party");
    await removeMember(env, id, user.id, "left");
    return json({ ok: true });
  }
  if (path === "/api/party/kick" && m === "POST") {                                   // KICK (owner only)
    const b = await readJson(req); const target = str(b.userId, "userId", 1, 40);
    const id = await partyOf(env, user.id); if (!id) throw new HttpError(404, "not_in_party");
    const p = await env.DB.prepare("SELECT owner FROM parties WHERE id = ?").bind(id).first<{ owner: string }>();
    if (!p || p.owner !== user.id) throw new HttpError(403, "owner_only");
    if (target === user.id) throw new HttpError(400, "cannot_kick_self");
    if ((await partyOf(env, target)) !== id) throw new HttpError(404, "not_a_member");
    await notify(env, target, { t: "party_kicked", reason: "kicked" });
    await removeMember(env, id, target, "kicked");
    return json({ ok: true });
  }

  if (path === "/api/party/invites" && m === "GET") {
    const now0 = now();
    const rows = await env.DB.prepare(
      `SELECT i.id, i.status, i.expires_at, i.from_user, i.to_user, u.id AS uid, u.username, u.display_name, u.avatar, u.created_at AS ucreated
       FROM party_invites i JOIN users u ON u.id = CASE WHEN i.to_user = ?1 THEN i.from_user ELSE i.to_user END
       WHERE (i.to_user = ?1 OR i.from_user = ?1) AND i.status = 'pending' AND i.expires_at > ?2`).bind(user.id, now0).all<any>();
    const mk = (r: any) => ({ id: r.id, expiresAt: r.expires_at, other: publicUser({ id: r.uid, username: r.username, display_name: r.display_name, avatar: r.avatar, created_at: r.ucreated }) });
    return json({ incoming: rows.results.filter((r) => r.to_user === user.id).map(mk), outgoing: rows.results.filter((r) => r.from_user === user.id).map(mk) });
  }
  if (path === "/api/party/invites" && m === "POST") {                                // INVITA AL PARTY
    limit(user.id, "party-invite", 20);
    const b = await readJson(req); const friendId = str(b.userId, "userId", 1, 40);
    const id = await partyOf(env, user.id); if (!id) throw new HttpError(409, "not_in_party");
    if (friendId === user.id) throw new HttpError(400, "invalid_user");
    if (await blockedEitherWay(env, user.id, friendId)) throw new HttpError(403, "user_blocked");
    if (!(await areFriends(env, user.id, friendId))) throw new HttpError(403, "not_friends");
    if (await partyOf(env, friendId)) throw new HttpError(409, "friend_in_party");
    if ((await presenceOf(env, friendId).status()).status === "OFFLINE") throw new HttpError(409, "friend_offline");
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?").bind(id).first<{ n: number }>();
    if ((cnt?.n ?? 0) >= PARTY_MAX) throw new HttpError(409, "party_full");
    const dup = await env.DB.prepare("SELECT 1 AS x FROM party_invites WHERE party_id = ? AND to_user = ? AND status = 'pending' AND expires_at > ?").bind(id, friendId, now()).first();
    if (dup) throw new HttpError(409, "invite_already_pending");
    const iid = randomId(12), t = now();
    await env.DB.prepare("INSERT INTO party_invites (id, party_id, from_user, to_user, status, created_at, expires_at) VALUES (?,?,?,?, 'pending', ?, ?)").bind(iid, id, user.id, friendId, t, t + PARTY_INVITE_TTL).run();
    await notify(env, friendId, { t: "party_invite", id: iid, from: publicUser(user), expiresAt: t + PARTY_INVITE_TTL });
    return json({ id: iid, expiresAt: t + PARTY_INVITE_TTL }, 201);
  }
  const im = path.match(/^\/api\/party\/invites\/([\w-]{8,40})(?:\/(respond))?$/);
  if (im) {
    const inv = await env.DB.prepare("SELECT * FROM party_invites WHERE id = ?").bind(im[1]).first<{ id: string; party_id: string; from_user: string; to_user: string; status: string; expires_at: number }>();
    if (m === "DELETE" && !im[2]) {                                                   // the inviter cancels
      if (!inv || inv.from_user !== user.id) throw new HttpError(404, "invite_not_found");
      if (inv.status === "pending") { await env.DB.prepare("UPDATE party_invites SET status = 'cancelled' WHERE id = ?").bind(inv.id).run(); await notify(env, inv.to_user, { t: "party_invite_update", id: inv.id, status: "cancelled" }); }
      return json({ ok: true });
    }
    if (m === "POST" && im[2] === "respond") {                                        // ACCETTA / RIFIUTA
      if (!inv || inv.to_user !== user.id) throw new HttpError(404, "invite_not_found");       // someone else's invite is indistinguishable from a missing one
      if (inv.status !== "pending") throw new HttpError(409, "invite_not_pending");
      if (inv.expires_at < now()) { await env.DB.prepare("UPDATE party_invites SET status = 'expired' WHERE id = ?").bind(inv.id).run(); throw new HttpError(410, "invite_expired"); }
      const b = await readJson(req);
      if (b.accept !== true) {
        await env.DB.prepare("UPDATE party_invites SET status = 'refused' WHERE id = ?").bind(inv.id).run();
        await notify(env, inv.from_user, { t: "party_invite_update", id: inv.id, status: "refused", by: publicUser(user) });
        return json({ ok: true, status: "refused" });
      }
      limit(user.id, "party-join", 20);
      if (await blockedEitherWay(env, user.id, inv.from_user)) { await env.DB.prepare("UPDATE party_invites SET status = 'cancelled' WHERE id = ?").bind(inv.id).run(); throw new HttpError(403, "user_blocked"); }
      if (await partyOf(env, user.id)) throw new HttpError(409, "already_in_party");
      const p = await env.DB.prepare("SELECT id, owner FROM parties WHERE id = ?").bind(inv.party_id).first<{ id: string; owner: string }>();
      if (!p) { await env.DB.prepare("UPDATE party_invites SET status = 'expired' WHERE id = ?").bind(inv.id).run(); throw new HttpError(410, "party_gone"); }
      if (await blockedEitherWay(env, user.id, p.owner)) throw new HttpError(403, "user_blocked");
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?").bind(p.id).first<{ n: number }>();
      if ((cnt?.n ?? 0) >= PARTY_MAX) throw new HttpError(409, "party_full");
      try { await env.DB.prepare("INSERT INTO party_members (party_id, user_id, joined_at) VALUES (?,?,?)").bind(p.id, user.id, now()).run(); }
      catch { throw new HttpError(409, "already_in_party"); }
      await env.DB.prepare("UPDATE party_invites SET status = 'accepted' WHERE id = ?").bind(inv.id).run();
      await touch(env, p.id); await presenceOf(env, user.id).setParty(p.id).catch(() => {});
      await notify(env, inv.from_user, { t: "party_invite_update", id: inv.id, status: "accepted", by: publicUser(user) });
      await tellMembers(env, p.id, { t: "party_update", reason: "joined" }, user.id);
      return json({ ok: true, status: "accepted", party: await snapshot(env, p.id) });
    }
  }
  throw new HttpError(404, "not_found");
}

/** WebSocket for the party signaling: membership is checked here, then the socket goes to the party's Durable Object */
export async function partySocket(env: Env, req: Request, user: User): Promise<Response> {
  const id = await partyOf(env, user.id); if (!id) throw new HttpError(403, "not_in_party");
  await touch(env, id);
  const h = new Headers(req.headers); h.set("x-dslink-user", user.id);
  return partyStub(env, id).fetch(new Request(req.url, { headers: h }));
}
