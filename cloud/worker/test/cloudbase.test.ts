import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { api, befriend, env, newAccount, openPresence, ORIGIN, sleep, until, uniq } from "./helpers";
import { SoftAuthenticator } from "./authenticator";

const PWA = "https://pwa.example";                       // a second allow-listed origin (a PWA hosted elsewhere)
const entry = (id: string, title = "Test Game " + id, extra: Record<string, unknown> = {}) => ({ gameId: id, platform: "nds", title, productCode: id.toUpperCase().slice(0, 4), coreId: "melonds-ds", multiplayerMode: "both", downloadPlaySupported: true, ...extra });
const gid = () => ("g" + uniq("")).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
const login = async (a: { username: string }) => (await api("POST", "/api/auth/login", { body: { username: a.username, password: "correct horse battery staple" } })).body.token as string;

// read a Server-Sent-Events response until a predicate is satisfied
async function sse(code: string, token: string) {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/signal/events?code=${code}&token=${token}`));
  const events: { event: string; data: any }[] = []; const rd = res.body!.getReader(), td = new TextDecoder(); let buf = ""; rd.closed.catch(() => {});
  (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += td.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: (\w+)\ndata: (.*)/s.exec(blk); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); } } } catch { /* closed */ } })();
  return { status: res.status, events, close: () => { /* the stream is left to the room (cancelling it from here makes workerd report an unhandled "Stream was cancelled") */ }, has: (ev: string, st?: string) => events.some((e) => e.event === ev && (!st || e.data.state === st)) };
}
const signal = (path: string, body: unknown) => exports.default.fetch(new Request(ORIGIN + path, { method: "POST", body: JSON.stringify(body) }));

describe("sessions: list, restore, revoke", () => {
  it("lists the devices an account is logged in on, flags the current one and tracks last_seen", async () => {
    const a = await newAccount(); const t2 = await login(a);
    const l1 = await api("GET", "/api/auth/sessions", { token: a.token });
    expect(l1.body.sessions).toHaveLength(2);
    expect(l1.body.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(l1.body.sessions.every((s: any) => /^[0-9a-f]{16}$/.test(s.id) && s.lastSeen > 0 && s.expiresAt > Date.now())).toBe(true);
    expect((await api("GET", "/api/auth/sessions", { token: t2 })).body.sessions.find((s: any) => s.current).id).not.toBe(l1.body.sessions.find((s: any) => s.current).id);
    const row = await env.DB.prepare("SELECT last_seen FROM users WHERE id = ?").bind(a.id).first<{ last_seen: number }>();
    expect(row!.last_seen).toBeGreaterThan(0);
  });
  it("restores the session (cookie/bearer), revokes one device, then all the others; only the owner can", async () => {
    const a = await newAccount(), b = await newAccount(); const t2 = await login(a), t3 = await login(a);
    expect((await api("GET", "/api/me", { token: t2 })).body.user.userId).toBe(a.id);                       // session restore: the same token still identifies the account
    const id2 = (await api("GET", "/api/auth/sessions", { token: t2 })).body.sessions.find((s: any) => s.current).id;
    expect((await api("DELETE", `/api/auth/sessions/${id2}`, { token: b.token })).status).toBe(404);          // another account cannot revoke it
    expect((await api("DELETE", `/api/auth/sessions/${id2}`, { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/me", { token: t2 })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: t3 })).status).toBe(200);
    const r = await api("POST", "/api/auth/sessions/revoke-others", { token: t3 });
    expect(r.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await api("GET", "/api/me", { token: a.token })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: t3 })).status).toBe(200);
    expect((await api("DELETE", `/api/auth/sessions/${"0".repeat(16)}`, { token: t3 })).status).toBe(404);
  });
  it("logout ends the session; a disabled account has no valid session; expired sessions are refused", async () => {
    const a = await newAccount(); const t2 = await login(a);
    const out = await api("POST", "/api/auth/logout", { token: t2 });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api("GET", "/api/me", { token: t2 })).status).toBe(401);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    expect((await api("GET", "/api/me", { token: a.token })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { body: { username: a.username, password: "correct horse battery staple" } })).status).toBe(200);   // (login itself is not the gate: every request is)
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(a.id).run();
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = 1 WHERE user_id = ?").bind(a.id).run();
    expect((await api("GET", "/api/me", { token: a.token })).status).toBe(401);
  });
  it("the cookie is HttpOnly and Lax for our own origin, SameSite=None; Secure for an allow-listed other origin", async () => {
    const name = uniq();
    const own = await api("POST", "/api/auth/register", { body: { username: name, password: "correct horse battery staple" } });
    expect(own.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(own.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    const cross = await api("POST", "/api/auth/login", { origin: PWA, body: { username: name, password: "correct horse battery staple" } });
    expect(cross.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(cross.headers.get("set-cookie")).toMatch(/SameSite=None; Max-Age=\d+; Secure|SameSite=None.*Secure/);
  });
  it("passkeys are created for the page's own domain (RP ID follows the allow-listed Origin)", async () => {
    const name = uniq();
    const o = await api("POST", "/api/auth/passkey/register/options", { origin: PWA, body: { username: name } });
    expect(o.body.options.rp.id).toBe("pwa.example");
    const auth = new SoftAuthenticator("pwa.example", PWA);
    const v = await api("POST", "/api/auth/passkey/register/verify", { origin: PWA, body: { cid: o.body.cid, response: await auth.register(o.body.options) } });
    expect(v.status).toBe(201);
    const lo = await api("POST", "/api/auth/passkey/login/options", { origin: PWA, body: {} });
    expect(lo.body.options.rpId).toBe("pwa.example");
    expect((await api("POST", "/api/auth/passkey/login/verify", { origin: PWA, body: { cid: lo.body.cid, response: await auth.authenticate(lo.body.options) } })).status).toBe(200);
  });
});

describe("CORS (allow-list with credentials) and the WebSocket ticket", () => {
  it("echoes ONLY allow-listed origins, with credentials, never '*'", async () => {
    const ok = await api("GET", "/api/health", { origin: PWA });
    expect(ok.headers.get("access-control-allow-origin")).toBe(PWA); expect(ok.headers.get("access-control-allow-credentials")).toBe("true"); expect(ok.headers.get("vary")).toContain("Origin");
    const evil = await api("GET", "/api/health", { origin: "https://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull(); expect(evil.headers.get("access-control-allow-credentials")).toBeNull();
    const none = await api("GET", "/api/health", { origin: null });
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    const err = await api("GET", "/api/me", { origin: PWA });
    expect(err.status).toBe(401); expect(err.headers.get("access-control-allow-origin")).toBe(PWA);        // errors are readable by the allowed page too
  });
  it("answers the preflight for allowed origins only; a state-changing request from another origin is refused (CSRF)", async () => {
    const pre = await api("OPTIONS", "/api/friends/requests", { origin: PWA, headers: { "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204); expect(pre.headers.get("access-control-allow-origin")).toBe(PWA); expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect((await api("OPTIONS", "/api/friends/requests", { origin: "https://evil.example" })).status).toBe(403);
    const a = await newAccount();
    expect((await api("POST", "/api/friends/requests", { token: a.token, origin: "https://evil.example", body: { username: "nobody" } })).status).toBe(403);
    expect((await api("POST", "/api/friends/requests", { token: a.token, origin: PWA, body: { username: "nobody123" } })).status).toBe(404);
  });
  it("a WebSocket opens with a one-shot ticket (no cookie needed), not twice, not expired, not from a foreign origin", async () => {
    const a = await newAccount();
    const t = await api("POST", "/api/ws-ticket", { token: a.token });
    expect(t.status).toBe(200); expect(t.body.ticket.length).toBeGreaterThan(16);
    const open = (ticket: string, origin = PWA) => exports.default.fetch(new Request(`${ORIGIN}/api/ws?ticket=${ticket}`, { headers: { upgrade: "websocket", origin } }));
    const r1 = await open(t.body.ticket); expect(r1.status).toBe(101); r1.webSocket!.accept(); r1.webSocket!.close();
    expect((await open(t.body.ticket)).status).toBe(401);                                                    // one shot
    const t2 = await api("POST", "/api/ws-ticket", { token: a.token });
    await env.DB.prepare("UPDATE challenges SET expires_at = 1 WHERE id = ?").bind(t2.body.ticket).run();
    expect((await open(t2.body.ticket)).status).toBe(401);                                                   // expired
    const t3 = await api("POST", "/api/ws-ticket", { token: a.token });
    expect((await open(t3.body.ticket, "https://evil.example")).status).toBe(403);                           // cross-site WebSocket hijacking guard
    expect((await api("POST", "/api/ws-ticket", {})).status).toBe(401);                                      // the ticket needs a logged-in user
  });
});

describe("blocks and the friendship relation", () => {
  it("search shows the relation (NONE / OUTGOING / INCOMING / FRIEND / BLOCKED) and hides who blocked me", async () => {
    const a = await newAccount(uniq("sa")), b = await newAccount(uniq("sb")), c = await newAccount(uniq("sc"));
    const rel = async (me: any, other: any) => (await api("GET", `/api/users/search?q=${other.username}`, { token: me.token })).body.users.find((u: any) => u.userId === other.id)?.relation;
    expect(await rel(a, b)).toBe("NONE");
    await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } });
    expect(await rel(a, b)).toBe("OUTGOING"); expect(await rel(b, a)).toBe("INCOMING");
    await befriend(a, c); expect(await rel(a, c)).toBe("FRIEND");
    await api("POST", "/api/blocks", { token: a.token, body: { username: b.username } });
    expect(await rel(a, b)).toBe("BLOCKED"); expect(await rel(b, a)).toBeUndefined();                       // b cannot even find a
    expect((await api("GET", `/api/users/${a.username}`, { token: b.token })).status).toBe(404);
    expect((await api("GET", `/api/users/${b.username}`, { token: a.token })).body.relation).toBe("BLOCKED");
    expect((await api("GET", "/api/users/search?q=a", { token: a.token })).body.users).toEqual([]);          // too short
    expect((await api("GET", "/api/users/search?q=%25", { token: a.token })).body.users).toEqual([]);        // LIKE wildcards are not honoured
  });
  it("blocking ends the friendship and every pending request/invite; nothing can be sent afterwards; unblocking reopens", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount();
    await befriend(a, b); await api("POST", "/api/friends/requests", { token: c.token, body: { username: a.username } });
    const bl = await api("POST", "/api/blocks", { token: a.token, body: { username: b.username } });
    expect(bl.status).toBe(201);
    expect((await api("GET", "/api/friends", { token: a.token })).body.friends).toHaveLength(0);
    expect((await api("GET", "/api/friends", { token: b.token })).body.friends).toHaveLength(0);
    expect((await api("POST", "/api/friends/requests", { token: b.token, body: { username: a.username } })).status).toBe(404);   // b: a no longer exists
    expect((await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } })).status).toBe(409);   // a: unblock first
    await api("POST", "/api/blocks", { token: a.token, body: { username: c.username } });
    expect((await api("GET", "/api/friends/requests", { token: a.token })).body.incoming).toHaveLength(0);       // c's pending request was cancelled by the block
    expect((await api("GET", "/api/blocks", { token: a.token })).body.blocked.map((u: any) => u.username).sort()).toEqual([b.username, c.username].sort());
    expect((await api("POST", "/api/blocks", { token: a.token, body: { username: a.username } })).status).toBe(400);
    expect((await api("POST", "/api/blocks", { token: a.token, body: { username: "nosuchuser9" } })).status).toBe(404);
    expect((await api("DELETE", `/api/blocks/${b.id}`, { token: a.token })).status).toBe(200);
    expect((await api("DELETE", `/api/blocks/${b.id}`, { token: a.token })).status).toBe(404);
    expect((await api("POST", "/api/friends/requests", { token: b.token, body: { username: a.username } })).status).toBe(201);
  });
  it("a block that lands at the same time as a request wins (no request after a block, even in a race)", async () => {
    for (let i = 0; i < 4; i++) {
      const a = await newAccount(), b = await newAccount();
      await Promise.all([api("POST", "/api/blocks", { token: b.token, body: { username: a.username } }), api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } })]);
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'").bind(a.id, b.id).first<{ n: number }>();
      expect(pending!.n).toBe(0);
    }
  });
});

describe("presence: ONLINE / MENU / IN_GAME, game title from the catalog, several devices", () => {
  it("shows the state a device reports, with the catalog title (never a client string or file name), and OFFLINE after the last device closes", async () => {
    const a = await newAccount(), b = await newAccount(); await befriend(a, b);
    const g = gid(); await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g, "Mario Party DS") });
    const st = async () => (await api("GET", "/api/friends", { token: b.token })).body.friends.find((f: any) => f.userId === a.id);
    expect((await st()).status).toBe("OFFLINE");
    const pb = await openPresence(b);
    const d1 = await openPresence(a);
    expect((await st()).status).toBe("ONLINE");
    d1.ws.send(JSON.stringify({ t: "state", state: "menu" }));
    await until(async () => (await st()).status === "MENU");
    d1.ws.send(JSON.stringify({ t: "state", state: "game", gameId: g }));
    const s = await until(async () => { const x = await st(); return x.status === "IN_GAME" && x; });
    expect(s.game).toEqual({ id: g, title: "Mario Party DS" });
    expect(JSON.stringify(s)).not.toMatch(/\.nds|rom/i);
    await until(() => pb.events.some((e) => e.t === "presence" && e.userId === a.id && e.status === "IN_GAME" && e.game?.title === "Mario Party DS"));
    d1.ws.send(JSON.stringify({ t: "state", state: "game", gameId: "unknown-game-id" }));
    await until(async () => { const x = await st(); return x.status === "IN_GAME" && x.game === null; });             // an unknown id shows no title
    d1.ws.send(JSON.stringify({ t: "bye" }));
    await until(async () => (await st()).status === "OFFLINE");
  });
  it("several devices of one account: the most active state wins and closing one falls back to the others", async () => {
    const a = await newAccount(), b = await newAccount(); await befriend(a, b);
    const g = gid(); await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g, "Gioco Due") });
    const st = async () => (await api("GET", "/api/friends", { token: b.token })).body.friends.find((f: any) => f.userId === a.id);
    const honor = await openPresence(a), iphone = await openPresence(a);
    honor.ws.send(JSON.stringify({ t: "state", state: "menu" })); iphone.ws.send(JSON.stringify({ t: "state", state: "game", gameId: g }));
    await until(async () => (await st()).status === "IN_GAME");
    iphone.ws.close(); await until(async () => (await st()).status === "MENU");
    honor.ws.close(); await until(async () => (await st()).status === "OFFLINE");
  });
  it("a silent network drop (no close, no pings) ends up OFFLINE through the sweep", async () => {
    const a = await newAccount(), b = await newAccount(); await befriend(a, b);
    const d = await openPresence(a);
    expect((await api("GET", "/api/friends", { token: b.token })).body.friends[0].status).toBe("ONLINE");
    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName(a.id));
    await runInDurableObject(stub, async (_i, state) => { for (const w of state.getWebSockets()) w.serializeAttachment({ lastSeen: Date.now() - 10 * 60_000, device: "" }); });
    await runDurableObjectAlarm(stub);
    await until(async () => (await api("GET", "/api/friends", { token: b.token })).body.friends[0].status === "OFFLINE");
    void d;
  });
});

describe("library metadata + generic game catalog (no files, any platform)", () => {
  it("the same account on two devices sees the same library; saves nothing but metadata", async () => {
    const a = await newAccount(); const phone2 = await login(a); const g = gid();
    expect((await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g, "Mario Party DS", { favorite: true }) })).status).toBe(200);
    const l = await api("GET", "/api/cloud/library", { token: phone2 });
    expect(l.body.entries).toHaveLength(1);
    expect(l.body.entries[0]).toMatchObject({ gameId: g, platform: "nds", title: "Mario Party DS", coreId: "melonds-ds", multiplayerMode: "both", downloadPlaySupported: true, favorite: true });
    expect(l.body.entries[0].addedAt).toBeGreaterThan(0);
    expect(JSON.stringify(l.body)).not.toMatch(/\.nds|bios|firmware/i);
    expect((await api("POST", `/api/cloud/library/${g}/played`, { token: phone2 })).status).toBe(200);
    expect((await api("GET", "/api/cloud/library", { token: a.token })).body.entries[0].lastPlayed).toBeGreaterThan(0);
    expect((await api("POST", `/api/cloud/library/${g}/favorite`, { token: a.token, body: { favorite: false } })).status).toBe(200);
    expect((await api("GET", "/api/cloud/library", { token: phone2 })).body.entries[0].favorite).toBe(false);
    expect((await api("DELETE", `/api/cloud/library/${g}`, { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/cloud/library", { token: phone2 })).body.entries).toHaveLength(0);
    expect((await api("DELETE", `/api/cloud/library/${g}`, { token: a.token })).status).toBe(404);
  });
  it("the catalog is generic and shared: a second account does not rewrite the title; batch sync; platform is free; validation", async () => {
    const a = await newAccount(), b = await newAccount(); const g = gid(), p = gid();
    await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g, "Original Title") });
    await api("PUT", "/api/cloud/library", { token: b.token, body: entry(g, "Hijacked <b>Title</b>") });
    expect((await api("GET", "/api/cloud/library", { token: b.token })).body.entries[0].title).toBe("Original Title");
    const s = await api("POST", "/api/cloud/library/sync", { token: a.token, body: { entries: [entry(p, "Crash Test", { platform: "ps1", coreId: "swanstation", multiplayerMode: "none", downloadPlaySupported: false }), entry(g)] } });
    expect(s.body.count).toBe(2);
    const lib = (await api("GET", "/api/cloud/library", { token: a.token })).body.entries;
    expect(lib.map((e: any) => e.platform).sort()).toEqual(["nds", "ps1"]);
    expect((await api("GET", "/api/catalog", { token: a.token })).body.games.length).toBeGreaterThanOrEqual(2);
    for (const bad of [{ ...entry("ab") }, { ...entry("UPPER CASE!") }, { ...entry(gid(), "") }, { ...entry(gid()), multiplayerMode: "wifi" }, { ...entry(gid()), platform: "x" }]) expect((await api("PUT", "/api/cloud/library", { token: a.token, body: bad })).status).toBe(400);
    expect((await api("POST", "/api/cloud/library/sync", { token: a.token, body: { entries: Array(201).fill(entry(gid())) } })).status).toBe(400);
    expect((await api("GET", "/api/cloud/library", {})).status).toBe(401);
  });
});

describe("play invites: friend -> invite -> accept -> the same signaling room", () => {
  async function setup() {
    const a = await newAccount(), b = await newAccount(); await befriend(a, b);
    const g = gid(); await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g, "Mario Party DS") });
    const pb = await openPresence(b);
    return { a, b, g, pb };
  }
  it("invite -> notification -> accept -> both land in ONE invite-only room and reach READY; the public code cannot take the seat", async () => {
    const { a, b, g, pb } = await setup();
    const inv = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    expect(inv.status).toBe(201); expect(inv.body.room.code).toMatch(/^\d{6}$/); expect(inv.body.room.token.length).toBeGreaterThan(16);
    const ev = await until(() => pb.events.find((e) => e.t === "invite"));
    expect(ev.from.userId).toBe(a.id); expect(ev.game).toMatchObject({ gameId: g, title: "Mario Party DS", platform: "nds" }); expect(JSON.stringify(ev)).not.toContain(inv.body.room.token);   // the host token never goes to the friend
    const list = await api("GET", "/api/play/invites", { token: b.token }); expect(list.body.incoming).toHaveLength(1); expect(JSON.stringify(list.body)).not.toMatch(/token/);
    expect((await api("GET", "/api/play/invites", { token: a.token })).body.outgoing).toHaveLength(1);
    expect((await signal("/signal/join", { code: inv.body.room.code })).status).toBe(409);                    // public join: the seat is reserved
    expect((await api("POST", `/api/play/invites/${inv.body.id}/respond`, { token: a.token, body: { accept: true } })).status).toBe(404);   // only the invited friend can answer
    const host = await sse(inv.body.room.code, inv.body.room.token);
    await until(() => host.has("state", "WAITING"));
    const acc = await api("POST", `/api/play/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } });
    expect(acc.status).toBe(200); expect(acc.body.status).toBe("accepted"); expect(acc.body.room.code).toBe(inv.body.room.code); expect(acc.body.gameId).toBe(g);
    const guest = await sse(acc.body.room.code, acc.body.room.token);
    await until(() => host.has("state", "READY") && guest.has("state", "READY"));
    expect(host.has("peer")).toBe(true);
    expect((await api("POST", `/api/play/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(409);   // answered once
    expect((await signal("/signal/join", { code: acc.body.room.code })).status).toBe(409);
    host.close(); guest.close();
  });
  it("the host is told of acceptance / refusal; a refusal closes the room; cancel closes it too", async () => {
    const { a, b, g } = await setup(); const pa = await openPresence(a);
    const i1 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    expect((await api("POST", `/api/play/invites/${i1.body.id}/respond`, { token: b.token, body: { accept: false } })).body.status).toBe("refused");
    await until(() => pa.events.find((e) => e.t === "invite_update" && e.status === "refused"));
    expect((await sse(i1.body.room.code, i1.body.room.token)).status).toBe(404);                           // room gone
    const i2 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    expect((await api("DELETE", `/api/play/invites/${i2.body.id}`, { token: a.token })).status).toBe(200);
    expect((await sse(i2.body.room.code, i2.body.room.token)).status).toBe(404);
    expect((await api("POST", `/api/play/invites/${i2.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(409);
    const i3 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    await api("POST", `/api/play/invites/${i3.body.id}/respond`, { token: b.token, body: { accept: true } });
    await until(() => pa.events.find((e) => e.t === "invite_update" && e.status === "accepted"));
  });
  it("only real friends, offline friends and busy friends cannot be invited; a new invite replaces the old one; the game must be in the host's library", async () => {
    const a = await newAccount(), b = await newAccount(), s = await newAccount(); await befriend(a, b); const g = gid();
    await api("PUT", "/api/cloud/library", { token: a.token, body: entry(g) });
    const inv = (to: any, game = g) => api("POST", "/api/play/invites", { token: a.token, body: { friendId: to.id, gameId: game } });
    expect((await inv(b)).body.error).toBe("friend_offline");
    const pb = await openPresence(b);
    expect((await inv(s)).status).toBe(403);                                                                 // a stranger
    expect((await inv(b, gid())).status).toBe(404);                                                         // game not in the library
    pb.ws.send(JSON.stringify({ t: "state", state: "game", gameId: g })); await sleep(100);
    expect((await inv(b)).body.error).toBe("friend_busy");
    pb.ws.send(JSON.stringify({ t: "state", state: "menu" })); await until(async () => (await api("GET", "/api/friends", { token: a.token })).body.friends[0].status === "MENU");
    const first = await inv(b); const second = await inv(b);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect((await sse(first.body.room.code, first.body.room.token)).status).toBe(404);                      // replaced: its room is closed
    expect((await api("GET", "/api/play/invites", { token: b.token })).body.incoming).toHaveLength(1);
  });
  it("blocking or unfriending cancels the open invite and closes its room; an expired invite cannot be accepted", async () => {
    const { a, b, g } = await setup(); const pa = await openPresence(a);
    const i1 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    await api("POST", "/api/blocks", { token: b.token, body: { username: a.username } });
    expect((await sse(i1.body.room.code, i1.body.room.token)).status).toBe(404);
    expect((await api("POST", `/api/play/invites/${i1.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(409);
    expect((await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } })).status).toBe(403);
    await api("DELETE", `/api/blocks/${a.id}`, { token: b.token }); await befriend(a, b);
    const i2 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    await api("DELETE", `/api/friends/${b.id}`, { token: a.token });
    expect((await sse(i2.body.room.code, i2.body.room.token)).status).toBe(404);
    await befriend(a, b);
    const i3 = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    await env.DB.prepare("UPDATE room_invites SET expires_at = 1 WHERE id = ?").bind(i3.body.id).run();
    expect((await api("POST", `/api/play/invites/${i3.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(410);
    await until(() => pa.events.find((e) => e.t === "invite_update" && e.status === "expired"));
    expect((await sse(i3.body.room.code, i3.body.room.token)).status).toBe(404);
    expect((await api("GET", "/api/play/invites", { token: b.token })).body.incoming).toHaveLength(0);
  });
  it("two devices of the invited account racing to accept: exactly one gets the seat", async () => {
    const { a, b, g } = await setup(); const b2 = await login(b);
    const inv = await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: g } });
    const [r1, r2] = await Promise.all([api("POST", `/api/play/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } }), api("POST", `/api/play/invites/${inv.body.id}/respond`, { token: b2, body: { accept: true } })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });
});

describe("signaling room states (CREATED > WAITING > READY > STARTING > IN_GAME, DISCONNECTED, CLOSED)", () => {
  it("walks the states for a public room and tells both sides", async () => {
    const c = await (await exports.default.fetch(new Request(ORIGIN + "/signal/create", { method: "POST" }))).json() as any;
    const j = await (await signal("/signal/join", { code: c.code })).json() as any;
    const host = await sse(c.code, c.token);
    await until(() => host.has("state", "WAITING"));
    const guest = await sse(c.code, j.token);
    await until(() => host.has("state", "READY") && guest.has("state", "READY"));
    expect((await signal("/signal/state", { code: c.code, token: j.token, state: "STARTING" })).status).toBe(403);       // only the host moves the room
    expect((await signal("/signal/state", { code: c.code, token: c.token, state: "NOPE" })).status).toBe(400);
    expect((await signal("/signal/state", { code: c.code, token: c.token, state: "STARTING" })).status).toBe(200);
    await until(() => host.has("state", "STARTING") && guest.has("state", "STARTING"));
    await signal("/signal/state", { code: c.code, token: c.token, state: "IN_GAME" });
    await until(() => guest.has("state", "IN_GAME"));
    guest.close();                                                                                             // the guest's page vanishes mid-game
    // (workerd does not always deliver the stream cancel to the Durable Object: the room's own silence detection, forced here, is what ends it)
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(env.SIGNAL.get(env.SIGNAL.idFromName("room:" + c.code)), async (i: any) => { i.room.staleMs = 60000; i.room.seen.host = Date.now(); i.room.seen.guest = 0; i.room.ping(); });
    await until(() => host.has("state", "DISCONNECTED"), 15000);
    const again = await sse(c.code, j.token);                                                                  // ... and comes back (reconnect)
    await until(() => again.has("state", "IN_GAME"));
    await signal("/signal/leave", { code: c.code, token: c.token });
    await until(() => again.has("state", "CLOSED"));
    expect((await signal("/signal/join", { code: c.code })).status).toBe(404);                                  // cleanup: the room is gone
    host.close(); again.close();
  });
});
