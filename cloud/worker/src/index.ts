import type { Env, User } from "./env";
import { authenticate, handleAuth, handleMe, publicUser } from "./auth";
import { handleFriends, presenceOf } from "./friends";
import { hostFor } from "./container";
import { handleInvites } from "./invites";
import { handleLibrary, purgeUserData } from "./library";
import { HttpError, json, logEvent, readJson, str, timingSafeEqual } from "./util";

export { Presence } from "./presence";
export { GameSession } from "./session";
export { DSLinkContainer } from "./container";

const sessionStub = (env: Env, id: string) => {
  let did: DurableObjectId;
  try { did = env.SESSION.idFromString(id); } catch { throw new HttpError(404, "session_not_found"); }
  return env.SESSION.get(did);
};

/** CSRF: state-changing requests must come from one of our origins (browsers always send Origin on those) */
function checkOrigin(env: Env, req: Request) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (!origin) return;                                            // non-browser client (carries a bearer token, no ambient cookies)
  const allowed = env.ORIGINS.split(",").map((s) => s.trim());
  if (!allowed.includes(origin) && origin !== new URL(req.url).origin) throw new HttpError(403, "bad_origin");
}

async function internal(env: Env, req: Request, path: string): Promise<Response> {
  const a = req.headers.get("authorization") ?? "";
  const enc = new TextEncoder();
  const ok = env.INTERNAL_TOKEN && timingSafeEqual(enc.encode(a), enc.encode("Bearer " + env.INTERNAL_TOKEN));
  const ticket = req.headers.get("x-dslink-ticket") ?? "";
  if (!ok || !ticket) throw new HttpError(401, "unauthorized");   // BOTH the shared secret and a live one-time ticket
  const m = path.match(/^\/internal\/sessions\/([\w-]+)\/(files\/([\w-]+)|slot\/([12])\/system\/([\w.-]+)|save\/(\w+))$/);
  if (!m) throw new HttpError(404, "not_found");
  const stub = sessionStub(env, m[1]);
  let key: string | null;
  if (m[3]) key = (await stub.authorize(ticket, { kind: "file", id: m[3] }))?.key ?? null;
  else if (m[4]) key = (await stub.authorize(ticket, { kind: "system", slot: Number(m[4]) as 1 | 2, name: m[5] }))?.key ?? null;
  else {
    if (!/^(sram|memcard1|memcard2)$/.test(m[6])) throw new HttpError(400, "invalid_save_kind");
    key = (await stub.authorize(ticket, { kind: "save", save: m[6], write: req.method === "PUT" }))?.key ?? null;
  }
  if (!key) throw new HttpError(403, "forbidden");
  if (req.method === "PUT" && m[6]) {
    const size = Number(req.headers.get("content-length"));
    if (!size || size > 8 * 2 ** 20 || !req.body) throw new HttpError(413, "invalid_save_size");
    await env.STORE.put(key, req.body);
    await stub.recordSave(m[6], size);
    return json({ ok: true });
  }
  if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
  const o = await env.STORE.get(key);
  if (!o) throw new HttpError(404, "missing");
  return new Response(o.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": String(o.size) } });
}

async function route(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.startsWith("/internal/")) return await internal(env, req, path);
  checkOrigin(env, req);
  if (path === "/api/health") return json({ ok: true });
  if (path === "/api/config") {   // WebRTC ICE servers for the game screen (TURN credentials come from the environment, never from code)
    let ice: unknown[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
    try { if (env.ICE_SERVERS) ice = JSON.parse(env.ICE_SERVERS); } catch { /* keep default */ }
    return json({ iceServers: ice });
  }

  const user = await authenticate(env, req);
  const pub = await handleAuth(env, req, path, user);
  if (pub) return pub;
  if (!user) throw new HttpError(401, "unauthenticated");

  const me = await handleMe(env, req, path, user);
  if (me) return me;

  if (path === "/api/logout-all" && req.method === "POST") {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(user.id).run();
    return json({ ok: true });
  }
  if (path === "/api/account" && req.method === "DELETE") {
    const b = await readJson(req);
    if (b.confirm !== user.username) throw new HttpError(400, "confirmation_required", "send {confirm: <your username>}");
    // end the user's live sessions first, so containers are destroyed and the other player is released
    const live = await env.DB.prepare("SELECT id FROM play_sessions WHERE (host_user = ?1 OR guest_user = ?1) AND status != 'ended'").bind(user.id).all<{ id: string }>();
    for (const s of live.results) { try { await sessionStub(env, s.id).end(null, "account_deleted"); } catch { /* gone */ } }
    const r = await purgeUserData(env, user.id);
    await presenceOf(env, user.id).purge();
    logEvent("account_deleted", { objects: r.objects });
    return json({ ok: true, deletedObjects: r.objects }, 200, { "set-cookie": "dsl_session=; HttpOnly; Path=/; Max-Age=0" });
  }

  if (path === "/api/ws" && req.headers.get("upgrade") === "websocket") {
    const h = new Headers(req.headers);
    h.set("x-dslink-user", user.id);
    h.set("x-dslink-device", (req.headers.get("user-agent") ?? "").slice(0, 60));
    return presenceOf(env, user.id).fetch(new Request(req.url, { headers: h }));
  }

  const lib = await handleLibrary(env, req, path, user);
  if (lib) return lib;
  const fr = await handleFriends(env, req, path, user);
  if (fr) return fr;
  const inv = await handleInvites(env, req, path, user);
  if (inv) return inv;

  if (path === "/api/history" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT id, host_user, guest_user, game_title, platform, status, started_at, ended_at FROM play_sessions WHERE host_user = ?1 OR guest_user = ?1 ORDER BY started_at DESC LIMIT 50").bind(user.id).all<any>();
    return json({ history: r.results.map((x) => ({ id: x.id, game: x.game_title, platform: x.platform, status: x.status, role: x.host_user === user.id ? "host" : "guest", startedAt: x.started_at, endedAt: x.ended_at })) });
  }

  if (path === "/api/sessions" && req.method === "POST") {   // GIOCA: a solo session with one of the user's own games
    const b = await readJson(req);
    const game = await env.DB.prepare("SELECT id, title, platform FROM games WHERE id = ? AND user_id = ? AND status = 'ready'").bind(str(b.gameId, "gameId", 1, 40), user.id).first<{ id: string; title: string; platform: "nds" | "ps1" }>();
    if (!game) throw new HttpError(404, "game_not_found");
    if ((await presenceOf(env, user.id).status()).status === "IN_GAME") throw new HttpError(409, "already_in_game");
    const sid = env.SESSION.newUniqueId().toString();
    await env.DB.prepare("INSERT INTO play_sessions (id, host_user, guest_user, game_title, platform, status, started_at) VALUES (?,?,?,?,?,'created',?)").bind(sid, user.id, "", game.title, game.platform, Date.now()).run();
    await env.SESSION.get(env.SESSION.idFromString(sid)).init(sid, { hostId: user.id, guestId: "", hostName: user.display_name, guestName: "", gameId: game.id, platform: game.platform, title: game.title });
    return json({ sessionId: sid }, 201);
  }

  const sm = path.match(/^\/api\/sessions\/([\w-]+)(?:\/(heartbeat|end|signal))?$/);
  if (sm) {
    const stub = sessionStub(env, sm[1]);
    const info = await stub.info(user.id);
    if (!info) throw new HttpError(404, "session_not_found");   // non-members cannot tell it exists
    if (!sm[2] && req.method === "GET") return json({ session: info });
    if (sm[2] === "heartbeat" && req.method === "POST") return json({ ok: await stub.heartbeat(user.id), status: info.status });
    if (sm[2] === "end" && req.method === "POST") return json({ ok: await stub.end(user.id, "user") });
    if (sm[2] === "signal" && req.headers.get("upgrade") === "websocket") {
      const host = await hostFor(env, info.id);
      if (!host) throw new HttpError(503, "container_unavailable");
      if (info.status !== "running") throw new HttpError(409, "session_not_ready");
      const g = await stub.gatewayAuth(user.id);
      if (!g) throw new HttpError(404, "session_not_found");
      const target = new URL(req.url);
      target.pathname = "/ws";
      target.search = `?player=${g.slot}&token=${encodeURIComponent(g.token)}&code=${encodeURIComponent(info.id)}`;
      return host.fetch(new Request(target.toString(), req));
    }
  }
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/internal/")) {
        return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
      }
      return await route(env, req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message === e.code ? undefined : e.message }, e.status);
      logEvent("unhandled_error", { message: String((e as Error)?.message ?? e).slice(0, 160) });
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
