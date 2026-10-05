import { describe, expect, it } from "vitest";
import { ORIGIN, api, newAccount, uniq } from "./helpers";
import { SoftAuthenticator } from "./authenticator";

describe("accounts: password", () => {
  it("registers, logs in, reads profile, logs out", async () => {
    const name = uniq();
    const r = await api("POST", "/api/auth/register", { body: { username: name, displayName: "Simone", password: "correct horse battery staple" } });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ username: name, displayName: "Simone" });
    expect(r.body.user.userId).toBeTruthy();
    expect(r.body.user.createdAt).toBeGreaterThan(0);
    expect(r.body.user.avatar).toMatch(/^a\d+$/);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=Lax/);

    const l = await api("POST", "/api/auth/login", { body: { username: name.toUpperCase(), password: "correct horse battery staple" } });
    expect(l.status).toBe(200);
    const me = await api("GET", "/api/me", { token: l.body.token });
    expect(me.body.user.username).toBe(name);

    await api("POST", "/api/auth/logout", { token: l.body.token });
    expect((await api("GET", "/api/me", { token: l.body.token })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: r.body.token })).status).toBe(200);   // other session untouched
  });

  it("never stores the password or the session token in clear", async () => {
    const { env } = await import("./helpers");
    const a = await newAccount();
    const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iters FROM users WHERE id = ?").bind(a.id).first<any>();
    expect(row.pw_iters).toBe(600000);
    expect(row.pw_hash).not.toContain("correct");
    expect(row.pw_salt.length).toBeGreaterThan(10);
    const s = await env.DB.prepare("SELECT token_hash FROM auth_sessions WHERE user_id = ?").bind(a.id).all<any>();
    expect(s.results.every((x: any) => x.token_hash !== a.token && x.token_hash.length === 64)).toBe(true);
  });

  it("same password, different users -> different hashes (per-user salt)", async () => {
    const { env } = await import("./helpers");
    const a = await newAccount(), b = await newAccount();
    const rows = await env.DB.prepare("SELECT pw_hash FROM users WHERE id IN (?, ?)").bind(a.id, b.id).all<any>();
    expect(new Set(rows.results.map((r: any) => r.pw_hash)).size).toBe(2);
  });

  it("rejects bad usernames, short passwords and duplicates", async () => {
    const name = uniq();
    expect((await api("POST", "/api/auth/register", { body: { username: "A!", password: "correct horse battery staple" } })).status).toBe(400);
    expect((await api("POST", "/api/auth/register", { body: { username: name, password: "short" } })).status).toBe(400);
    await newAccount(name);
    const d = await api("POST", "/api/auth/register", { body: { username: name.toUpperCase(), password: "correct horse battery staple" } });
    expect(d.status).toBe(409);
  });

  it("wrong password and unknown user look the same; repeated failures are throttled", async () => {
    const a = await newAccount();
    const w = await api("POST", "/api/auth/login", { body: { username: a.username, password: "nope nope nope" } });
    const u = await api("POST", "/api/auth/login", { body: { username: uniq("ghost"), password: "nope nope nope" } });
    expect(w.status).toBe(401); expect(u.status).toBe(401);
    expect(w.body).toEqual(u.body);
    for (let i = 0; i < 4; i++) await api("POST", "/api/auth/login", { body: { username: a.username, password: "bad bad bad bad" } });
    const t = await api("POST", "/api/auth/login", { body: { username: a.username, password: "correct horse battery staple" } });
    expect(t.status).toBe(429);   // locked even for the right password during the window
  });

  it("profile update and avatar validation", async () => {
    const a = await newAccount();
    const p = await api("PATCH", "/api/me", { token: a.token, body: { displayName: "Nuovo Nome", avatar: "a3" } });
    expect(p.body.user).toMatchObject({ displayName: "Nuovo Nome", avatar: "a3" });
    expect((await api("PATCH", "/api/me", { token: a.token, body: { avatar: "evil.png" } })).status).toBe(400);
  });
});

describe("accounts: passkeys (WebAuthn, software authenticator)", () => {
  it("registers with a passkey, logs in with it (no password, no username), counter advances", async () => {
    const name = uniq("pk");
    const auth = new SoftAuthenticator("dslink.test", ORIGIN);
    const o = await api("POST", "/api/auth/passkey/register/options", { body: { username: name, displayName: "Passkey User" } });
    expect(o.status).toBe(200);
    expect(o.body.options.rp.id).toBe("dslink.test");
    expect(o.body.options.authenticatorSelection.residentKey).toBe("required");
    const v = await api("POST", "/api/auth/passkey/register/verify", { body: { cid: o.body.cid, response: await auth.register(o.body.options) } });
    expect(v.status).toBe(201);
    expect(v.body.user.username).toBe(name);

    const lo = await api("POST", "/api/auth/passkey/login/options", { body: {} });
    const lv = await api("POST", "/api/auth/passkey/login/verify", { body: { cid: lo.body.cid, response: await auth.authenticate(lo.body.options) } });
    expect(lv.status).toBe(200);
    expect(lv.body.user.userId).toBe(v.body.user.userId);
    expect((await api("GET", "/api/me", { token: lv.body.token })).body.passkeys).toBe(1);

    // password login must not work for a passkey-only account
    expect((await api("POST", "/api/auth/login", { body: { username: name, password: "anything at all" } })).status).toBe(401);
  });

  it("a challenge is single-use and a replayed assertion fails", async () => {
    const name = uniq("pk");
    const auth = new SoftAuthenticator("dslink.test", ORIGIN);
    const o = await api("POST", "/api/auth/passkey/register/options", { body: { username: name } });
    const resp = await auth.register(o.body.options);
    expect((await api("POST", "/api/auth/passkey/register/verify", { body: { cid: o.body.cid, response: resp } })).status).toBe(201);
    expect((await api("POST", "/api/auth/passkey/register/verify", { body: { cid: o.body.cid, response: resp } })).status).toBe(400);
    const lo = await api("POST", "/api/auth/passkey/login/options", { body: {} });
    const assertion = await auth.authenticate(lo.body.options);
    expect((await api("POST", "/api/auth/passkey/login/verify", { body: { cid: lo.body.cid, response: assertion } })).status).toBe(200);
    expect((await api("POST", "/api/auth/passkey/login/verify", { body: { cid: lo.body.cid, response: assertion } })).status).toBe(400);
  });

  it("rejects an assertion for a different origin / challenge", async () => {
    const name = uniq("pk");
    const good = new SoftAuthenticator("dslink.test", ORIGIN);
    const o = await api("POST", "/api/auth/passkey/register/options", { body: { username: name } });
    await api("POST", "/api/auth/passkey/register/verify", { body: { cid: o.body.cid, response: await good.register(o.body.options) } });
    const evil = Object.assign(Object.create(Object.getPrototypeOf(good)), good, { origin: "https://evil.example" });
    const lo = await api("POST", "/api/auth/passkey/login/options", { body: {} });
    const bad = await api("POST", "/api/auth/passkey/login/verify", { body: { cid: lo.body.cid, response: await evil.authenticate(lo.body.options) } });
    expect(bad.status).toBe(401);
  });

  it("adds a second passkey to a logged-in account", async () => {
    const a = await newAccount();
    const dev2 = new SoftAuthenticator("dslink.test", ORIGIN);
    const o = await api("POST", "/api/auth/passkey/add/options", { token: a.token, body: {} });
    expect(o.status).toBe(200);
    const v = await api("POST", "/api/auth/passkey/add/verify", { token: a.token, body: { cid: o.body.cid, response: await dev2.register(o.body.options) } });
    expect(v.status).toBe(200);
    expect((await api("GET", "/api/me", { token: a.token })).body.passkeys).toBe(1);
    const lo = await api("POST", "/api/auth/passkey/login/options", { body: {} });
    const lv = await api("POST", "/api/auth/passkey/login/verify", { body: { cid: lo.body.cid, response: await dev2.authenticate(lo.body.options) } });
    expect(lv.body.user.userId).toBe(a.id);
    expect((await api("POST", "/api/auth/passkey/add/options", { body: {} })).status).toBe(401);
  });
});

describe("request hygiene", () => {
  it("requires authentication", async () => {
    for (const [m, p] of [["GET", "/api/me"], ["GET", "/api/library"], ["GET", "/api/friends"], ["GET", "/api/invites"], ["GET", "/api/history"]]) expect((await api(m, p)).status).toBe(401);
  });
  it("blocks cross-site state changes (CSRF origin check)", async () => {
    const a = await newAccount();
    const r = await api("PATCH", "/api/me", { token: a.token, body: { displayName: "x" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
  it("internal routes need the shared secret", async () => {
    expect((await api("GET", "/internal/sessions/abc/files/x", { headers: { "x-dslink-ticket": "t" } })).status).toBe(401);
  });
});
