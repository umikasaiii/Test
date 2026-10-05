// Private game library + BIOS/firmware + saves. Everything lives in the PRIVATE R2 bucket under u/<userId>/...,
// is only ever reachable through authenticated, ownership-checked routes, and never appears in logs.
import { AwsClient } from "aws4fetch";
import type { Env, Platform, User } from "./env";
import { classifyByHeader, isChdHeader, isNdsHeader, ndsTitle, parseCue, SIZE_LIMITS, type FileRole } from "./detect";
import { HttpError, json, logEvent, now, randomId, readJson, str, unb64url } from "./util";

export const PROXY_MAX = 95 * 2 ** 20;           // Worker request-body ceiling; bigger files need presigned direct upload
const PENDING_TTL = 24 * 3600 * 1000;
const SAVE_MAX = 8 * 2 ** 20;
export const SYSTEM_FILES: Record<Platform, { names: RegExp; sizes: number[] }> = {
  nds: { names: /^(bios7|bios9|firmware)\.bin$/, sizes: [16384, 4096, 131072, 262144, 524288] },
  ps1: { names: /^[A-Za-z0-9_.-]{1,64}\.bin$/, sizes: [524288] },
};
const SYSTEM_SIZE: Record<string, number[]> = { "bios7.bin": [16384], "bios9.bin": [4096], "firmware.bin": [131072, 262144, 524288] };

export const userPrefix = (uid: string) => `u/${uid}/`;
const fileKey = (uid: string, gid: string, fid: string) => `${userPrefix(uid)}g/${gid}/${fid}`;
const sysKey = (uid: string, platform: string, name: string) => `${userPrefix(uid)}sys/${platform}/${name}`;
const saveKey = (uid: string, gid: string, kind: string) => `${userPrefix(uid)}saves/${gid}/${kind}`;

async function presign(env: Env, key: string, size: number): Promise<string | null> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) return null;
  const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}?X-Amz-Expires=900`;
  const signed = await aws.sign(new Request(url, { method: "PUT", headers: { "content-length": String(size) } }), { aws: { signQuery: true } });
  return signed.url;
}

async function ownGame(env: Env, user: User, gid: string) {
  const g = await env.DB.prepare("SELECT id, user_id, title, platform, status, created_at FROM games WHERE id = ? AND user_id = ?").bind(gid, user.id).first<{ id: string; user_id: string; title: string; platform: Platform; status: string; created_at: number }>();
  if (!g) throw new HttpError(404, "game_not_found");   // other users' games are indistinguishable from missing ones
  return g;
}

async function deleteGameObjects(env: Env, uid: string, gid: string) {
  const prefixes = [`${userPrefix(uid)}g/${gid}/`, `${userPrefix(uid)}saves/${gid}/`];
  for (const p of prefixes) await deleteByPrefix(env, p);
}

export async function deleteByPrefix(env: Env, prefix: string): Promise<number> {
  let n = 0, cursor: string | undefined;
  do {
    const l = await env.STORE.list({ prefix, cursor, limit: 500 });
    if (l.objects.length) { await env.STORE.delete(l.objects.map((o) => o.key)); n += l.objects.length; }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return n;
}

async function gcPending(env: Env, user: User) {
  const old = await env.DB.prepare("SELECT id FROM games WHERE user_id = ? AND status = 'pending' AND created_at < ?").bind(user.id, now() - PENDING_TTL).all<{ id: string }>();
  for (const g of old.results) { await deleteGameObjects(env, user.id, g.id); await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(g.id).run(); }
}

async function createGame(env: Env, req: Request, user: User): Promise<Response> {
  const body = await readJson(req, 512 * 1024);
  const files = body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 12) throw new HttpError(400, "invalid_files");
  await gcPending(env, user);
  const items: { name: string; size: number; role: FileRole; platform: Platform | null; header: Uint8Array }[] = [];
  for (const f of files as Record<string, unknown>[]) {
    const name = str(f.name, "name", 1, 200).replace(/[\\/]/g, "_");
    const size = Number(f.size);
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "invalid_size");
    const header = typeof f.header === "string" && f.header.length <= 4096 ? unb64url(f.header) : new Uint8Array(0);
    const c = classifyByHeader(name, header);
    if (!c) throw new HttpError(415, "unsupported_file", "expected a valid .nds, .chd, .cue + .bin");
    if (size > SIZE_LIMITS[c.role]) throw new HttpError(413, "file_too_large");
    items.push({ name, size, role: c.role, platform: c.platform, header });
  }
  const roles = items.map((i) => i.role);
  const count = (r: FileRole) => roles.filter((x) => x === r).length;
  let platform: Platform;
  if (roles.length === 1 && roles[0] === "rom") platform = "nds";
  else if (roles.length === 1 && roles[0] === "chd") platform = "ps1";
  else if (count("cue") === 1 && count("bin") >= 1 && count("rom") + count("chd") === 0) platform = "ps1";
  else throw new HttpError(422, "invalid_combination", "one .nds, one .chd, or one .cue with its .bin files");
  if (new Set(items.map((i) => i.name.toLowerCase())).size !== items.length) throw new HttpError(422, "duplicate_names");

  const gid = randomId(12);
  const title = (platform === "nds" ? ndsTitle(items[0].header) : "") || items.find((i) => i.role !== "bin")!.name.replace(/\.[^.]+$/, "").slice(0, 80);
  await env.DB.prepare("INSERT INTO games (id, user_id, title, platform, status, created_at) VALUES (?,?,?,?,'pending',?)").bind(gid, user.id, title, platform, now()).run();
  const uploads = [];
  for (const it of items) {
    const fid = randomId(10);
    const key = fileKey(user.id, gid, fid);
    await env.DB.prepare("INSERT INTO game_files (id, game_id, role, name, size, r2_key) VALUES (?,?,?,?,?,?)").bind(fid, gid, it.role, it.name, it.size, key).run();
    const direct = await presign(env, key, it.size);
    if (!direct && it.size > PROXY_MAX) { await deleteGameObjects(env, user.id, gid); await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gid).run(); throw new HttpError(413, "needs_direct_upload", "file too large for the proxied upload and R2 presigning is not configured"); }
    uploads.push({ fileId: fid, name: it.name, size: it.size, role: it.role,
      mode: direct ? "presigned" : "proxy", method: "PUT", url: direct ?? `/api/library/games/${gid}/files/${fid}` });
  }
  return json({ gameId: gid, platform, title, uploads }, 201);
}

async function proxyUpload(env: Env, req: Request, user: User, gid: string, fid: string): Promise<Response> {
  const g = await ownGame(env, user, gid);
  if (g.status !== "pending") throw new HttpError(409, "game_not_pending");
  const f = await env.DB.prepare("SELECT id, size, r2_key FROM game_files WHERE id = ? AND game_id = ?").bind(fid, gid).first<{ id: string; size: number; r2_key: string }>();
  if (!f) throw new HttpError(404, "file_not_found");
  if (f.size > PROXY_MAX) throw new HttpError(413, "needs_direct_upload");
  if (Number(req.headers.get("content-length")) !== f.size || !req.body) throw new HttpError(400, "size_mismatch");
  await env.STORE.put(f.r2_key, req.body, { httpMetadata: { contentType: "application/octet-stream" } });
  return json({ ok: true });
}

async function complete(env: Env, user: User, gid: string): Promise<Response> {
  const g = await ownGame(env, user, gid);
  if (g.status === "ready") return json({ ok: true, title: g.title, platform: g.platform });
  const files = (await env.DB.prepare("SELECT id, role, name, size, r2_key FROM game_files WHERE game_id = ?").bind(gid).all<{ id: string; role: FileRole; name: string; size: number; r2_key: string }>()).results;
  const fail = async (code: string) => { await deleteGameObjects(env, user.id, gid); await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gid).run(); throw new HttpError(422, code); };
  let title = g.title;
  for (const f of files) {
    const head = await env.STORE.head(f.r2_key);
    if (!head) return fail("upload_missing");
    if (head.size !== f.size) return fail("size_mismatch");
    if (f.role === "rom" || f.role === "chd") {
      const o = await env.STORE.get(f.r2_key, { range: { offset: 0, length: 0x200 } });
      const h = new Uint8Array(await o!.arrayBuffer());
      if (f.role === "rom") { if (!isNdsHeader(h)) return fail("invalid_nds"); title = ndsTitle(h) || title; }
      else if (!isChdHeader(h)) return fail("invalid_chd");
    }
  }
  if (g.platform === "ps1" && files.some((f) => f.role === "cue")) {
    const cue = files.find((f) => f.role === "cue")!;
    const text = await (await env.STORE.get(cue.r2_key))!.text();
    const refs = parseCue(text);
    if (!refs) return fail("invalid_cue");
    const bins = new Set(files.filter((f) => f.role === "bin").map((f) => f.name.toLowerCase()));
    if (refs.some((r) => !bins.has(r.toLowerCase())) || [...bins].some((b) => !refs.map((r) => r.toLowerCase()).includes(b))) return fail("cue_bin_mismatch");
  }
  await env.DB.prepare("UPDATE game_files SET ok = 1 WHERE game_id = ?").bind(gid).run();
  await env.DB.prepare("UPDATE games SET status = 'ready', title = ? WHERE id = ?").bind(title, gid).run();
  logEvent("game_added", { platform: g.platform });
  return json({ ok: true, gameId: gid, title, platform: g.platform });
}

export async function listGames(env: Env, user: User) {
  await gcPending(env, user);
  const rows = await env.DB.prepare(
    `SELECT g.id, g.title, g.platform, g.created_at, COALESCE(SUM(f.size),0) AS size, COUNT(f.id) AS files,
            (SELECT COUNT(*) FROM saves s WHERE s.game_id = g.id) AS saves
     FROM games g LEFT JOIN game_files f ON f.game_id = g.id WHERE g.user_id = ? AND g.status = 'ready' GROUP BY g.id ORDER BY g.created_at DESC`).bind(user.id).all<any>();
  return rows.results.map((r) => ({ id: r.id, title: r.title, platform: r.platform, size: r.size, files: r.files, hasSave: r.saves > 0, createdAt: r.created_at }));
}

async function systemFiles(env: Env, req: Request, user: User, path: string): Promise<Response | null> {
  if (req.method === "GET" && path === "/api/library/system") {
    const r = await env.DB.prepare("SELECT platform, name, size, created_at FROM system_files WHERE user_id = ? ORDER BY platform, name").bind(user.id).all<any>();
    return json({ files: r.results.map((x) => ({ platform: x.platform, name: x.name, size: x.size, createdAt: x.created_at })) });   // metadata only: bytes are never served back
  }
  const m = path.match(/^\/api\/library\/system\/(nds|ps1)\/([A-Za-z0-9_.-]{1,64})$/);
  if (!m) return null;
  const platform = m[1] as Platform, name = m[2].toLowerCase();
  if (!SYSTEM_FILES[platform].names.test(name)) throw new HttpError(400, "unsupported_system_file");
  if (req.method === "PUT") {
    const size = Number(req.headers.get("content-length"));
    const allowed = platform === "nds" ? SYSTEM_SIZE[name] : SYSTEM_FILES.ps1.sizes;
    if (!allowed.includes(size) || !req.body) throw new HttpError(422, "invalid_system_file_size");
    const key = sysKey(user.id, platform, name);
    await env.STORE.put(key, req.body, { httpMetadata: { contentType: "application/octet-stream" } });
    await env.DB.prepare("INSERT INTO system_files (id, user_id, platform, name, size, r2_key, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id, platform, name) DO UPDATE SET size = excluded.size, created_at = excluded.created_at")
      .bind(randomId(10), user.id, platform, name, size, key, now()).run();
    return json({ ok: true, platform, name, size });
  }
  if (req.method === "DELETE") {
    await env.STORE.delete(sysKey(user.id, platform, name));
    await env.DB.prepare("DELETE FROM system_files WHERE user_id = ? AND platform = ? AND name = ?").bind(user.id, platform, name).run();
    return json({ ok: true });
  }
  return null;
}

async function saves(env: Env, req: Request, user: User, gid: string, kind: string): Promise<Response> {
  await ownGame(env, user, gid);
  if (!/^(sram|memcard1|memcard2)$/.test(kind)) throw new HttpError(400, "invalid_save_kind");
  const key = saveKey(user.id, gid, kind);
  if (req.method === "PUT") {
    const size = Number(req.headers.get("content-length"));
    if (!size || size > SAVE_MAX || !req.body) throw new HttpError(413, "invalid_save_size");
    await env.STORE.put(key, req.body);
    await env.DB.prepare("INSERT INTO saves (id, user_id, game_id, kind, size, r2_key, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(game_id, kind) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at")
      .bind(randomId(10), user.id, gid, kind, size, key, now()).run();
    return json({ ok: true, size });
  }
  if (req.method === "GET") {
    const o = await env.STORE.get(key);
    if (!o) throw new HttpError(404, "no_save");
    return new Response(o.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-disposition": `attachment; filename="${kind}.sav"` } });
  }
  if (req.method === "DELETE") {
    await env.STORE.delete(key);
    await env.DB.prepare("DELETE FROM saves WHERE game_id = ? AND kind = ?").bind(gid, kind).run();
    return json({ ok: true });
  }
  throw new HttpError(405, "method_not_allowed");
}

export async function handleLibrary(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/library") return json({ games: await listGames(env, user) });
  if (m === "POST" && path === "/api/library/games") return createGame(env, req, user);
  const sys = await systemFiles(env, req, user, path);
  if (sys) return sys;
  let mm = path.match(/^\/api\/library\/games\/([\w-]+)\/files\/([\w-]+)$/);
  if (m === "PUT" && mm) return proxyUpload(env, req, user, mm[1], mm[2]);
  mm = path.match(/^\/api\/library\/games\/([\w-]+)\/complete$/);
  if (m === "POST" && mm) return complete(env, user, mm[1]);
  mm = path.match(/^\/api\/library\/games\/([\w-]+)\/save\/(\w+)$/);
  if (mm) return saves(env, req, user, mm[1], mm[2]);
  mm = path.match(/^\/api\/library\/games\/([\w-]+)$/);
  if (mm && m === "PATCH") {
    const g = await ownGame(env, user, mm[1]);
    const b = await readJson(req);
    const title = str(b.title, "title", 1, 80).trim();
    await env.DB.prepare("UPDATE games SET title = ? WHERE id = ?").bind(title, g.id).run();
    return json({ ok: true, title });
  }
  if (mm && m === "DELETE") {
    const g = await ownGame(env, user, mm[1]);
    await deleteGameObjects(env, user.id, g.id);
    await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(g.id).run();
    return json({ ok: true });
  }
  return null;
}

/** account deletion: every object and row owned by the user */
export async function purgeUserData(env: Env, uid: string): Promise<{ objects: number }> {
  const objects = await deleteByPrefix(env, userPrefix(uid));
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid).run();  // ON DELETE CASCADE: credentials, sessions, games, files, saves, friendships, requests, invites
  await env.DB.prepare("DELETE FROM play_sessions WHERE host_user = ?").bind(uid).run();
  await env.DB.prepare("UPDATE play_sessions SET guest_user = 'deleted' WHERE guest_user = ?").bind(uid).run();   // the host's own history keeps the row, without the identity
  return { objects };
}
