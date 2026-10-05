// Accounts: passkeys (WebAuthn, @simplewebauthn/server) and, as a fallback, e-mail-less username + password hashed with
// PBKDF2-SHA256 (WebCrypto, 600k iterations, per-user salt). No home-grown crypto: only platform primitives and a vetted library.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Env, User } from "./env";
import { HttpError, b64url, json, now, randomId, randomToken, readJson, sha256hex, str, timingSafeEqual, unb64url, logEvent } from "./util";

export const SESSION_COOKIE = "dsl_session";
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
export const PBKDF2_ITERS = 600_000;

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const AVATARS = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11"];

const origins = (env: Env) => env.ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

export async function hashPassword(password: string, salt: Uint8Array<ArrayBuffer>, iters = PBKDF2_ITERS): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256));
}

function cookieFor(token: string, env: Env, maxAgeSec: number): string {
  const secure = env.ENVIRONMENT === "test" || env.ENVIRONMENT === "dev" ? "" : "; Secure";   // localhost development only
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function createSession(env: Env, userId: string, req: Request): Promise<{ token: string; cookie: string }> {
  const token = randomToken();
  const t = now();
  await env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, device) VALUES (?,?,?,?,?)")
    .bind(await sha256hex(token), userId, t, t + SESSION_TTL, (req.headers.get("user-agent") ?? "").slice(0, 120)).run();
  return { token, cookie: cookieFor(token, env, SESSION_TTL / 1000) };
}

export function readToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const c = req.headers.get("cookie");
  if (!c) return null;
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return null;
}

export async function authenticate(env: Env, req: Request): Promise<User | null> {
  const token = readToken(req);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name, u.avatar, u.created_at, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(await sha256hex(token)).first<User & { expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
    return null;
  }
  const { expires_at: _e, ...user } = row;
  return user;
}

export const publicUser = (u: User) => ({ userId: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, createdAt: u.created_at });

function validateProfile(body: Record<string, unknown>) {
  const username = str(body.username, "username", 3, 20).toLowerCase();
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "invalid_username", "3-20 chars: a-z 0-9 _");
  const displayName = body.displayName === undefined ? username : str(body.displayName, "displayName", 1, 32).trim();
  if (!displayName) throw new HttpError(400, "invalid_displayName");
  const avatar = body.avatar === undefined ? AVATARS[Math.floor(Math.random() * AVATARS.length)] : str(body.avatar, "avatar", 1, 8);
  if (!AVATARS.includes(avatar)) throw new HttpError(400, "invalid_avatar");
  return { username, displayName, avatar };
}

async function usernameFree(env: Env, username: string) {
  const r = await env.DB.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(username).first();
  if (r) throw new HttpError(409, "username_taken");
}

async function saveChallenge(env: Env, kind: string, data: unknown): Promise<string> {
  const id = randomId(18);
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now()).run();
  await env.DB.prepare("INSERT INTO challenges (id, kind, data, expires_at) VALUES (?,?,?,?)").bind(id, kind, JSON.stringify(data), now() + CHALLENGE_TTL).run();
  return id;
}
async function takeChallenge<T>(env: Env, id: string, kind: string): Promise<T> {
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING data, expires_at").bind(id, kind).first<{ data: string; expires_at: number }>();
  if (!row || row.expires_at < now()) throw new HttpError(400, "challenge_expired");
  return JSON.parse(row.data) as T;
}

function sessionResponse(env: Env, user: User, s: { token: string; cookie: string }, status = 200) {
  return json({ user: publicUser(user), token: s.token }, status, { "set-cookie": s.cookie });
}

// ---------- password accounts ----------
async function register(env: Env, req: Request): Promise<Response> {
  const body = await readJson(req);
  const p = validateProfile(body);
  const password = str(body.password, "password", 10, 200);
  await usernameFree(env, p.username);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  const id = randomId(12);
  const t = now();
  try {
    await env.DB.prepare("INSERT INTO users (id, username, display_name, avatar, created_at, pw_hash, pw_salt, pw_iters) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, p.username, p.displayName, p.avatar, t, b64url(hash), b64url(salt), PBKDF2_ITERS).run();
  } catch { throw new HttpError(409, "username_taken"); }
  const user: User = { id, username: p.username, display_name: p.displayName, avatar: p.avatar, created_at: t };
  logEvent("account_created", { method: "password" });
  return sessionResponse(env, user, await createSession(env, id, req), 201);
}

async function throttle(env: Env, key: string, ok?: boolean) {
  const t = now();
  const row = await env.DB.prepare("SELECT failures, window_end FROM login_attempts WHERE key = ?").bind(key).first<{ failures: number; window_end: number }>();
  const active = row && row.window_end > t ? row : null;
  if (ok === undefined) {
    if (active && active.failures >= 5) throw new HttpError(429, "too_many_attempts");
    return;
  }
  if (ok) { await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run(); return; }
  await env.DB.prepare("INSERT INTO login_attempts (key, failures, window_end) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET failures = ?, window_end = ?")
    .bind(key, t + 15 * 60_000, (active?.failures ?? 0) + 1, active ? active.window_end : t + 15 * 60_000).run();
}

async function login(env: Env, req: Request): Promise<Response> {
  const body = await readJson(req);
  const username = str(body.username, "username", 1, 40).toLowerCase();
  const password = str(body.password, "password", 1, 200);
  const key = "u:" + username;
  await throttle(env, key);
  const row = await env.DB.prepare("SELECT id, username, display_name, avatar, created_at, pw_hash, pw_salt, pw_iters FROM users WHERE username = ?")
    .bind(username).first<User & { pw_hash: string | null; pw_salt: string | null; pw_iters: number | null }>();
  // always spend the KDF time, so unknown users and passkey-only users are indistinguishable by timing
  const salt = row?.pw_salt ? unb64url(row.pw_salt) : new Uint8Array(16);
  const got = await hashPassword(password, salt, row?.pw_iters ?? PBKDF2_ITERS);
  const ok = !!row?.pw_hash && timingSafeEqual(got, unb64url(row.pw_hash));
  await throttle(env, key, ok);
  if (!ok || !row) throw new HttpError(401, "invalid_credentials");
  const user: User = { id: row.id, username: row.username, display_name: row.display_name, avatar: row.avatar, created_at: row.created_at };
  return sessionResponse(env, user, await createSession(env, user.id, req));
}

// ---------- passkeys ----------
async function passkeyRegisterOptions(env: Env, req: Request, existing: User | null): Promise<Response> {
  const body = existing ? {} : await readJson(req);
  const profile = existing ? { username: existing.username, displayName: existing.display_name, avatar: existing.avatar } : validateProfile(body);
  if (!existing) await usernameFree(env, profile.username);
  const userId = existing?.id ?? randomId(12);
  const creds = existing ? (await env.DB.prepare("SELECT id FROM credentials WHERE user_id = ?").bind(existing.id).all<{ id: string }>()).results : [];
  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME, rpID: env.RP_ID, userName: profile.username, userDisplayName: profile.displayName,
    userID: new Uint8Array(new TextEncoder().encode(userId)) as Uint8Array<ArrayBuffer>, attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: creds.map((c) => ({ id: c.id })),
  });
  const cid = await saveChallenge(env, "reg", { challenge: options.challenge, userId, existing: !!existing, ...profile });
  return json({ cid, options });
}

async function passkeyRegisterVerify(env: Env, req: Request, existing: User | null): Promise<Response> {
  const body = await readJson(req, 256 * 1024);
  const ch = await takeChallenge<{ challenge: string; userId: string; existing: boolean; username: string; displayName: string; avatar: string }>(env, str(body.cid, "cid", 1, 64), "reg");
  if (ch.existing !== !!existing || (existing && existing.id !== ch.userId)) throw new HttpError(400, "challenge_mismatch");
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origins(env), expectedRPID: env.RP_ID, requireUserVerification: false });
  } catch { throw new HttpError(400, "registration_failed"); }
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, "registration_failed");
  const { credential } = v.registrationInfo;
  const t = now();
  let user: User;
  if (existing) user = existing;
  else {
    await usernameFree(env, ch.username);
    user = { id: ch.userId, username: ch.username, display_name: ch.displayName, avatar: ch.avatar, created_at: t };
    try {
      await env.DB.prepare("INSERT INTO users (id, username, display_name, avatar, created_at) VALUES (?,?,?,?,?)").bind(user.id, user.username, user.display_name, user.avatar, t).run();
    } catch { throw new HttpError(409, "username_taken"); }
  }
  await env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?,?,?,?,?,?)")
    .bind(credential.id, user.id, b64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), t).run();
  logEvent(existing ? "passkey_added" : "account_created", { method: "passkey" });
  return sessionResponse(env, user, await createSession(env, user.id, req), existing ? 200 : 201);
}

async function passkeyLoginOptions(env: Env): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "preferred" });  // discoverable credential: no username needed
  const cid = await saveChallenge(env, "auth", { challenge: options.challenge });
  return json({ cid, options });
}

async function passkeyLoginVerify(env: Env, req: Request): Promise<Response> {
  const body = await readJson(req, 256 * 1024);
  const ch = await takeChallenge<{ challenge: string }>(env, str(body.cid, "cid", 1, 64), "auth");
  const resp = body.response as AuthenticationResponseJSON;
  const cred = await env.DB.prepare("SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?").bind(String(resp?.id ?? "")).first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!cred) throw new HttpError(401, "unknown_credential");
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: resp, expectedChallenge: ch.challenge, expectedOrigin: origins(env), expectedRPID: env.RP_ID, requireUserVerification: false,
      credential: { id: cred.id, publicKey: unb64url(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
    });
  } catch { throw new HttpError(401, "authentication_failed"); }
  if (!v.verified) throw new HttpError(401, "authentication_failed");
  await env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, cred.id).run();
  const user = await env.DB.prepare("SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?").bind(cred.user_id).first<User>();
  if (!user) throw new HttpError(401, "unknown_credential");
  return sessionResponse(env, user, await createSession(env, user.id, req));
}

export async function handleAuth(env: Env, req: Request, path: string, user: User | null): Promise<Response | null> {
  const m = req.method;
  if (m === "POST" && path === "/api/auth/register") return register(env, req);
  if (m === "POST" && path === "/api/auth/login") return login(env, req);
  if (m === "POST" && path === "/api/auth/passkey/register/options") return passkeyRegisterOptions(env, req, null);
  if (m === "POST" && path === "/api/auth/passkey/register/verify") return passkeyRegisterVerify(env, req, null);
  if (m === "POST" && path === "/api/auth/passkey/login/options") return passkeyLoginOptions(env);
  if (m === "POST" && path === "/api/auth/passkey/login/verify") return passkeyLoginVerify(env, req);
  if (m === "POST" && path === "/api/auth/passkey/add/options") { if (!user) throw new HttpError(401, "unauthenticated"); return passkeyRegisterOptions(env, req, user); }
  if (m === "POST" && path === "/api/auth/passkey/add/verify") { if (!user) throw new HttpError(401, "unauthenticated"); return passkeyRegisterVerify(env, req, user); }
  if (m === "POST" && path === "/api/auth/logout") {
    const t = readToken(req);
    if (t) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256hex(t)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieFor("", env, 0) });
  }
  return null;
}

export async function handleMe(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  if (path === "/api/me" && req.method === "GET") {
    const creds = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    return json({ user: publicUser(user), passkeys: creds?.n ?? 0, avatars: AVATARS });
  }
  if (path === "/api/me" && req.method === "PATCH") {
    const b = await readJson(req);
    const dn = b.displayName === undefined ? user.display_name : str(b.displayName, "displayName", 1, 32).trim();
    const av = b.avatar === undefined ? user.avatar : str(b.avatar, "avatar", 1, 8);
    if (!dn || !AVATARS.includes(av)) throw new HttpError(400, "invalid_profile");
    await env.DB.prepare("UPDATE users SET display_name = ?, avatar = ? WHERE id = ?").bind(dn, av, user.id).run();
    return json({ user: publicUser({ ...user, display_name: dn, avatar: av }) });
  }
  return null;
}
