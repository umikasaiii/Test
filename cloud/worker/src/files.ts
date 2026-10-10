// DSLink Cloud storage: the user's OWN ROMs, BIOS/firmware and save history in a PRIVATE R2 bucket.
// - R2 has no public access and no custom domain: every byte goes through these authenticated, ownership-checked routes (Worker streaming). No permanent public URL exists.
// - Object keys are opaque (u/<user>/cf/... , u/<user>/cs/...): a file name or game id is never a path, so there is no path to traverse; every lookup is (user_id, kind, name) from the session.
// - D1 keeps identifiers, sizes and SHA-256 only. Nothing here logs a name, a key or a byte of content.
// - Emulation never reads from here: the PWA downloads a file, verifies the hash, stores it locally, and only then runs it.
import type { Env, User } from "./env";
import { isNdsHeader, ndsTitle } from "./detect";
import { deleteByPrefix, userPrefix } from "./library";
import { upsertCatalog } from "./catalog";
import { HttpError, json, logEvent, now, randomId, readJson, str, unb64url } from "./util";

export const CHUNK = 8 * 2 ** 20;                 // upload part size (R2 multipart needs >= 5 MiB except the last part)
export const ROM_MAX = 512 * 2 ** 20;
export const SAVE_MAX = 8 * 2 ** 20;
export const SAVE_KEEP = 5;                       // revisions kept per game
const UPLOAD_TTL = 24 * 3600 * 1000;
const MAX_PENDING = 8;
// the user's own BIOS files: Nintendo DS (bios7, bios9, firmware) and PlayStation (one 512 KiB BIOS per region). Sizes only: the Cloud never inspects or compares a BIOS.
const SYSTEM_SIZES: Record<string, number[]> = { "bios7.bin": [16384], "bios9.bin": [4096], "firmware.bin": [131072, 262144, 524288], "ps1-bios-na.bin": [524288], "ps1-bios-eu.bin": [524288], "ps1-bios-jp.bin": [524288] };
const GAME_RE = /^[a-z0-9]{2,8}-[a-z0-9]{4,12}$/;
const HEX = /^[0-9a-f]{64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{6,64}$/;

const filesPrefix = (uid: string) => `${userPrefix(uid)}cf/`;
const savesPrefix = (uid: string) => `${userPrefix(uid)}cs/`;

// ---------------------------------------------------------------- helpers
const bucket = (env: Env): R2Bucket => { if (!env.STORE) throw new HttpError(503, "storage_unavailable"); return env.STORE; };
/** any R2 failure is reported as "storage unavailable" (never a stack trace, never a key) and nothing local is affected */
async function r2<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    logEvent("r2_error", { message: String((e as Error)?.message ?? e).slice(0, 80).replace(/u\/[\w-]+\/[^\s"']*/g, "<key>") });
    throw new HttpError(503, "storage_unavailable");
  }
}
export const quotaBytes = (env: Env) => Math.max(1, Number(env.QUOTA_MB) || 2048) * 2 ** 20;

// basic per-account rate limiting (per Worker isolate: enough to stop a runaway client or a script, not a distributed attack)
const hits = new Map<string, number[]>();
function limit(userId: string, what: string, max: number, windowMs = 10 * 60_000) {
  const k = userId + ":" + what, t = now(), a = (hits.get(k) ?? []).filter((x) => t - x < windowMs);
  if (a.length >= max) { hits.set(k, a); throw new HttpError(429, "rate_limited"); }
  a.push(t); hits.set(k, a);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(kk);
}

async function usage(env: Env, uid: string) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(size),0) FROM cloud_files WHERE user_id = ?1 AND kind = 'game') AS games,
            (SELECT COALESCE(SUM(size),0) FROM cloud_files WHERE user_id = ?1 AND kind = 'system') AS system,
            (SELECT COALESCE(SUM(size),0) FROM cloud_saves WHERE user_id = ?1) AS saves,
            (SELECT COALESCE(SUM(size),0) FROM cloud_uploads WHERE user_id = ?1 AND expires_at > ?2) AS pending`).bind(uid, now()).first<{ games: number; system: number; saves: number; pending: number }>();
  const u = r ?? { games: 0, system: 0, saves: 0, pending: 0 };
  return { ...u, used: u.games + u.system + u.saves, quota: undefined as number | undefined };
}

async function sha256Of(body: ReadableStream<Uint8Array>): Promise<string> {
  const ds = new crypto.DigestStream("SHA-256");
  await body.pipeTo(ds);
  return [...new Uint8Array(await ds.digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const hexOf = async (buf: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((x) => x.toString(16).padStart(2, "0")).join("");

function checkName(kind: string, nameRaw: unknown): string {
  const name = str(nameRaw, "name", 3, 40).toLowerCase();
  if (kind === "game") { if (!GAME_RE.test(name)) throw new HttpError(400, "invalid_name"); }
  else if (kind === "system") { if (!Object.prototype.hasOwnProperty.call(SYSTEM_SIZES, name)) throw new HttpError(400, "invalid_name"); }
  else throw new HttpError(400, "invalid_kind");
  return name;
}

async function gc(env: Env, uid: string) {
  const old = await env.DB.prepare("SELECT id, r2_key, mode, upload_id FROM cloud_uploads WHERE user_id = ? AND expires_at < ?").bind(uid, now()).all<{ id: string; r2_key: string; mode: string; upload_id: string }>();
  for (const u of old.results) await dropUpload(env, u);
}
async function dropUpload(env: Env, u: { id: string; r2_key: string; mode: string; upload_id: string }) {
  try { if (u.mode === "multipart") await bucket(env).resumeMultipartUpload(u.r2_key, u.upload_id).abort(); } catch { /* already gone / completed */ }
  try { await bucket(env).delete(u.r2_key); } catch { /* nothing stored */ }
  await env.DB.prepare("DELETE FROM cloud_uploads WHERE id = ?").bind(u.id).run();
}

// ---------------------------------------------------------------- routes
export async function handleFiles(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  if (!path.startsWith("/api/files") && !path.startsWith("/api/saves") && path !== "/api/storage") return null;
  const m = req.method;

  if (path === "/api/storage" && m === "GET") {
    const u = await usage(env, user.id); u.quota = quotaBytes(env);
    const c = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM cloud_files WHERE user_id = ?1 AND kind = 'game') AS games, (SELECT COUNT(*) FROM cloud_files WHERE user_id = ?1 AND kind = 'system') AS system, (SELECT COUNT(DISTINCT game_id) FROM cloud_saves WHERE user_id = ?1) AS saves").bind(user.id).first<{ games: number; system: number; saves: number }>();
    return json({ quotaBytes: u.quota, usedBytes: u.used, gamesBytes: u.games, systemBytes: u.system, savesBytes: u.saves, games: c?.games ?? 0, systemFiles: c?.system ?? 0, saveGames: c?.saves ?? 0 });
  }

  if (path === "/api/files" && m === "GET") {
    const rows = await env.DB.prepare("SELECT kind, name, size, sha256, title, updated_at FROM cloud_files WHERE user_id = ? ORDER BY kind, name").bind(user.id).all<{ kind: string; name: string; size: number; sha256: string; title: string; updated_at: number }>();
    return json({
      games: rows.results.filter((r) => r.kind === "game").map((r) => ({ gameId: r.name, title: r.title, size: r.size, sha256: r.sha256, updatedAt: r.updated_at })),
      system: rows.results.filter((r) => r.kind === "system").map((r) => ({ name: r.name, size: r.size, sha256: r.sha256, updatedAt: r.updated_at })),
      quotaBytes: quotaBytes(env), usedBytes: (await usage(env, user.id)).used,
    });
  }
  if (path === "/api/files" && m === "DELETE") return await purgeMine(env, req, user);          // "delete all my Cloud data" (the account stays)

  if (path === "/api/files/uploads" && m === "POST") return await startUpload(env, req, user);
  const up = path.match(/^\/api\/files\/uploads\/([\w-]{8,40})(?:\/(parts\/(\d{1,5})|complete))?$/);
  if (up) {
    const row = await env.DB.prepare("SELECT * FROM cloud_uploads WHERE id = ? AND user_id = ?").bind(up[1], user.id).first<Upload>();
    if (!row || row.expires_at < now()) throw new HttpError(404, "upload_not_found");      // someone else's upload id is indistinguishable from a missing one
    if (!up[2] && m === "GET") {
      const parts = await env.DB.prepare("SELECT part FROM cloud_upload_parts WHERE upload_id = ? ORDER BY part").bind(row.id).all<{ part: number }>();
      return json({ uploadId: row.id, mode: row.mode, size: row.size, chunkSize: row.chunk, partsTotal: partCount(row), parts: parts.results.map((p) => p.part) });
    }
    if (!up[2] && m === "DELETE") { await dropUpload(env, row); return json({ ok: true }); }
    if (up[3] && m === "PUT") return await putPart(env, req, user, row, Number(up[3]));
    if (up[2] === "complete" && m === "POST") return await complete(env, user, row);
    throw new HttpError(405, "method_not_allowed");
  }

  const fm = path.match(/^\/api\/files\/(game|system)\/([a-z0-9._-]{3,40})$/);
  if (fm) {
    const kind = fm[1], name = checkName(kind, fm[2]);
    const row = await env.DB.prepare("SELECT size, sha256, r2_key FROM cloud_files WHERE user_id = ? AND kind = ? AND name = ?").bind(user.id, kind, name).first<{ size: number; sha256: string; r2_key: string }>();
    if (!row) throw new HttpError(404, "file_not_found");
    if (m === "GET") return await stream(env, req, row.r2_key, row.size, row.sha256);
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM cloud_files WHERE user_id = ? AND kind = ? AND name = ?").bind(user.id, kind, name).run();
      await r2(() => bucket(env).delete(row.r2_key));
      return json({ ok: true });
    }
    throw new HttpError(405, "method_not_allowed");
  }

  if (path.startsWith("/api/saves")) return await saves(env, req, path, user);
  throw new HttpError(404, "not_found");
}

interface Upload { id: string; user_id: string; kind: string; name: string; size: number; sha256: string; title: string; r2_key: string; mode: string; upload_id: string; chunk: number; expires_at: number }
const partCount = (u: { size: number; chunk: number }) => Math.max(1, Math.ceil(u.size / u.chunk));
const partSize = (u: { size: number; chunk: number }, n: number) => (n < partCount(u) ? u.chunk : u.size - (partCount(u) - 1) * u.chunk);

async function startUpload(env: Env, req: Request, user: User): Promise<Response> {
  limit(user.id, "upload", 40);
  const b = await readJson(req, 16 * 1024);
  const kind = str(b.kind, "kind", 4, 6), name = checkName(kind, b.name);
  const size = Number(b.size), sha = String(b.sha256 ?? "").toLowerCase();
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "invalid_size");
  if (!HEX.test(sha)) throw new HttpError(400, "invalid_sha256");
  let title = "";
  if (kind === "game") {
    if (size > ROM_MAX) throw new HttpError(413, "file_too_large");
    const head = typeof b.header === "string" && b.header.length <= 1400 ? unb64url(b.header) : new Uint8Array(0);
    if (!isNdsHeader(head)) throw new HttpError(415, "invalid_file", "not a Nintendo DS ROM");           // structure, not the extension: a renamed file is refused
    const code = String.fromCharCode(...head.subarray(12, 16)).toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(code) || name !== "nds-" + code) throw new HttpError(422, "game_id_mismatch");
    title = (typeof b.title === "string" ? b.title.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) : "") || ndsTitle(head);
  } else if (!SYSTEM_SIZES[name].includes(size)) throw new HttpError(422, "invalid_size", "not the expected size for this file");

  await gc(env, user.id);
  const existing = await env.DB.prepare("SELECT size, sha256 FROM cloud_files WHERE user_id = ? AND kind = ? AND name = ?").bind(user.id, kind, name).first<{ size: number; sha256: string }>();
  if (existing && existing.sha256 === sha && existing.size === size) return json({ done: true, deduplicated: true });   // same bytes already in this account: nothing to upload
  const u = await usage(env, user.id), q = quotaBytes(env);
  if (u.used + u.pending - (existing?.size ?? 0) + size > q) throw new HttpError(507, "cloud_quota_exceeded", `quota ${q}`);
  const pend = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_uploads WHERE user_id = ? AND expires_at > ?").bind(user.id, now()).first<{ n: number }>();
  if ((pend?.n ?? 0) >= MAX_PENDING) throw new HttpError(429, "too_many_uploads");

  const id = randomId(18), key = `${filesPrefix(user.id)}${kind}/${randomId(16)}`, mode = size > CHUNK ? "multipart" : "single";
  let uploadId = "";
  if (mode === "multipart") uploadId = (await r2(() => bucket(env).createMultipartUpload(key, { httpMetadata: { contentType: "application/octet-stream" } }))).uploadId;
  else bucket(env);
  await env.DB.prepare("INSERT INTO cloud_uploads (id, user_id, kind, name, size, sha256, title, r2_key, mode, upload_id, chunk, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, user.id, kind, name, size, sha, title, key, mode, uploadId, CHUNK, now(), now() + UPLOAD_TTL).run();
  return json({ uploadId: id, mode, chunkSize: CHUNK, partsTotal: partCount({ size, chunk: CHUNK }), expiresAt: now() + UPLOAD_TTL }, 201);
}

async function putPart(env: Env, req: Request, _user: User, u: Upload, n: number): Promise<Response> {
  if (n < 1 || n > partCount(u)) throw new HttpError(400, "invalid_part");
  const want = partSize(u, n);
  const declared = Number(req.headers.get("content-length") ?? "-1");
  if (declared !== -1 && declared !== want) throw new HttpError(400, "size_mismatch");
  if (!req.body) throw new HttpError(400, "empty_part");
  const buf = await req.arrayBuffer();                                         // one part (<= 8 MiB), never the whole file
  if (buf.byteLength !== want) throw new HttpError(400, "size_mismatch");
  let etag = "single";
  if (u.mode === "single") await r2(() => bucket(env).put(u.r2_key, buf, { httpMetadata: { contentType: "application/octet-stream" } }));
  else etag = (await r2(() => bucket(env).resumeMultipartUpload(u.r2_key, u.upload_id).uploadPart(n, buf))).etag;
  await env.DB.prepare("INSERT OR REPLACE INTO cloud_upload_parts (upload_id, part, etag, size) VALUES (?,?,?,?)").bind(u.id, n, etag, want).run();
  return json({ ok: true, part: n });
}

async function complete(env: Env, user: User, u: Upload): Promise<Response> {
  const parts = (await env.DB.prepare("SELECT part, etag FROM cloud_upload_parts WHERE upload_id = ? ORDER BY part").bind(u.id).all<{ part: number; etag: string }>()).results;
  const total = partCount(u), have = new Set(parts.map((p) => p.part));
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !have.has(i));
  if (missing.length) return json({ error: "parts_missing", missing }, 409);
  const fail = async (status: number, code: string) => { await dropUpload(env, u); throw new HttpError(status, code); };
  if (u.mode === "multipart") await r2(() => bucket(env).resumeMultipartUpload(u.r2_key, u.upload_id).complete(parts.map((p) => ({ partNumber: p.part, etag: p.etag }))));
  const head = await r2(() => bucket(env).head(u.r2_key));
  if (!head || head.size !== u.size) return await fail(422, "size_mismatch");
  const obj = await r2(() => bucket(env).get(u.r2_key));
  if (!obj) return await fail(422, "upload_missing");
  const digest = await r2(() => sha256Of(obj.body));                           // hashed while streaming: the file is never held in memory
  const headerBytes = new Uint8Array(await (await r2(() => bucket(env).get(u.r2_key, { range: { offset: 0, length: 512 } })))!.arrayBuffer());
  if (digest !== u.sha256) return await fail(422, "hash_mismatch");            // integrity: what arrived is what the client hashed
  if (u.kind === "game") {
    if (!isNdsHeader(headerBytes) || "nds-" + String.fromCharCode(...headerBytes.subarray(12, 16)).toLowerCase() !== u.name) return await fail(415, "invalid_file");
  }
  const old = await env.DB.prepare("SELECT r2_key FROM cloud_files WHERE user_id = ? AND kind = ? AND name = ?").bind(user.id, u.kind, u.name).first<{ r2_key: string }>();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO cloud_files (user_id, kind, name, size, sha256, r2_key, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(user.id, u.kind, u.name, u.size, u.sha256, u.r2_key, u.title, t, t),
    env.DB.prepare("DELETE FROM cloud_uploads WHERE id = ?").bind(u.id),
  ]);
  if (old && old.r2_key !== u.r2_key) await r2(() => bucket(env).delete(old.r2_key));
  if (u.kind === "game") await upsertCatalog(env, user.id, u.name, u.title);     // the game appears in the account's library metadata
  return json({ ok: true, kind: u.kind, name: u.name, size: u.size, sha256: u.sha256 });
}

async function stream(env: Env, req: Request, key: string, size: number, sha: string, extra: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-disposition": "attachment", etag: `"${sha}"`, "accept-ranges": "bytes", "x-dslink-sha256": sha, ...extra };
  const range = req.headers.get("range"), rm = range ? range.match(/^bytes=(\d*)-(\d*)$/) : null;
  if (rm && (rm[1] !== "" || rm[2] !== "")) {
    let start: number, end: number;
    if (rm[1] === "") { const n = Number(rm[2]); start = Math.max(0, size - n); end = size - 1; } else { start = Number(rm[1]); end = rm[2] === "" ? size - 1 : Math.min(Number(rm[2]), size - 1); }
    if (!(start <= end) || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const o = await r2(() => bucket(env).get(key, { range: { offset: start, length: end - start + 1 } }));
    if (!o) throw new HttpError(404, "file_not_found");
    return new Response(o.body, { status: 206, headers: { ...h, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  const o = await r2(() => bucket(env).get(key));
  if (!o) throw new HttpError(404, "file_not_found");
  return new Response(o.body, { headers: { ...h, "content-length": String(size) } });
}

// ---------------------------------------------------------------- saves: linear revisions, conflict detection by base revision
interface SaveRow { game_id: string; revision: number; device_id: string; device_name: string; size: number; sha256: string; r2_key: string; note: string; created_at: number }
const saveInfo = (r: SaveRow) => ({ gameId: r.game_id, revision: r.revision, deviceId: r.device_id, deviceName: r.device_name, size: r.size, sha256: r.sha256, note: r.note, updatedAt: r.created_at });

async function head(env: Env, uid: string, gid: string) {
  return await env.DB.prepare("SELECT * FROM cloud_saves WHERE user_id = ? AND game_id = ? ORDER BY revision DESC LIMIT 1").bind(uid, gid).first<SaveRow>();
}

async function saves(env: Env, req: Request, path: string, user: User): Promise<Response> {
  const m = req.method;
  if (path === "/api/saves" && m === "GET") {
    const rows = await env.DB.prepare("SELECT s.* FROM cloud_saves s WHERE s.user_id = ?1 AND s.revision = (SELECT MAX(revision) FROM cloud_saves WHERE user_id = ?1 AND game_id = s.game_id) ORDER BY s.game_id").bind(user.id).all<SaveRow>();
    return json({ saves: rows.results.map(saveInfo) });
  }
  const sm = path.match(/^\/api\/saves\/([a-z0-9]{2,8}-[a-z0-9]{4,12})(?:\/(data|restore))?$/);
  if (!sm) throw new HttpError(404, "not_found");
  const gid = sm[1];
  const url = new URL(req.url);

  if (!sm[2] && m === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM cloud_saves WHERE user_id = ? AND game_id = ? ORDER BY revision DESC").bind(user.id, gid).all<SaveRow>();
    return json({ head: rows.results[0] ? saveInfo(rows.results[0]) : null, history: rows.results.map(saveInfo) });
  }
  if (!sm[2] && m === "DELETE") {
    await env.DB.prepare("DELETE FROM cloud_saves WHERE user_id = ? AND game_id = ?").bind(user.id, gid).run();
    await r2(() => deleteByPrefix(env, `${savesPrefix(user.id)}${gid}/`));
    return json({ ok: true });
  }
  if (sm[2] === "data" && m === "GET") {
    const rev = url.searchParams.get("rev");
    const row = rev ? await env.DB.prepare("SELECT * FROM cloud_saves WHERE user_id = ? AND game_id = ? AND revision = ?").bind(user.id, gid, Number(rev) | 0).first<SaveRow>() : await head(env, user.id, gid);
    if (!row) throw new HttpError(404, "save_not_found");
    return await stream(env, req, row.r2_key, row.size, row.sha256, { "x-dslink-revision": String(row.revision) });
  }
  if (!sm[2] && m === "PUT") {
    limit(user.id, "save", 240);
    const base = Number(url.searchParams.get("base") ?? "0"), force = url.searchParams.get("force") === "1";
    const device = url.searchParams.get("device") ?? "", dname = (url.searchParams.get("name") ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 40);
    if (!Number.isInteger(base) || base < 0) throw new HttpError(400, "invalid_base");
    if (!DEVICE_RE.test(device)) throw new HttpError(400, "invalid_device");
    const declared = Number(req.headers.get("content-length") ?? "-1");
    if (declared > SAVE_MAX) throw new HttpError(413, "save_too_large");
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty_save");
    if (buf.byteLength > SAVE_MAX) throw new HttpError(413, "save_too_large");
    const sha = await hexOf(buf), claimed = url.searchParams.get("sha");
    if (claimed && claimed !== sha) throw new HttpError(422, "hash_mismatch");
    const cur = await head(env, user.id, gid);
    if (cur && cur.sha256 === sha) return json({ ok: true, unchanged: true, revision: cur.revision, head: saveInfo(cur) });
    if (cur && base !== cur.revision && !force) return json({ error: "save_conflict", head: saveInfo(cur) }, 409);
    return await writeRevision(env, user, gid, cur, buf, sha, device, dname, "");
  }
  if (sm[2] === "restore" && m === "POST") {
    const b = await readJson(req, 4096);
    const rev = Number(b.revision);
    const device = String(b.device ?? ""), dname = String(b.name ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 40);
    if (!Number.isInteger(rev) || rev < 1) throw new HttpError(400, "invalid_revision");
    if (!DEVICE_RE.test(device)) throw new HttpError(400, "invalid_device");
    const src = await env.DB.prepare("SELECT * FROM cloud_saves WHERE user_id = ? AND game_id = ? AND revision = ?").bind(user.id, gid, rev).first<SaveRow>();
    if (!src) throw new HttpError(404, "revision_not_found");
    const o = await r2(() => bucket(env).get(src.r2_key));
    if (!o) throw new HttpError(404, "revision_not_found");
    const buf = await o.arrayBuffer();
    const cur = await head(env, user.id, gid);
    return await writeRevision(env, user, gid, cur, buf, src.sha256, device, dname, "restore:" + rev);       // a restore is a NEW revision: history stays linear and nothing is lost
  }
  throw new HttpError(405, "method_not_allowed");
}

async function writeRevision(env: Env, user: User, gid: string, cur: SaveRow | null, buf: ArrayBuffer, sha: string, device: string, dname: string, note: string): Promise<Response> {
  const u = await usage(env, user.id);
  if (u.used + u.pending + buf.byteLength > quotaBytes(env)) throw new HttpError(507, "cloud_quota_exceeded");
  const rev = (cur?.revision ?? 0) + 1, key = `${savesPrefix(user.id)}${gid}/${rev}-${randomId(10)}`;
  await r2(() => bucket(env).put(key, buf, { httpMetadata: { contentType: "application/octet-stream" } }));
  try {
    await env.DB.prepare("INSERT INTO cloud_saves (user_id, game_id, revision, device_id, device_name, size, sha256, r2_key, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(user.id, gid, rev, device, dname, buf.byteLength, sha, key, note, now()).run();
  } catch {                                                                    // two devices wrote the same next revision at once: the loser is a conflict, never an overwrite
    await bucket(env).delete(key).catch(() => {});
    const h = await head(env, user.id, gid);
    return json({ error: "save_conflict", head: h ? saveInfo(h) : null }, 409);
  }
  const old = await env.DB.prepare("SELECT revision, r2_key FROM cloud_saves WHERE user_id = ? AND game_id = ? AND revision <= ? ORDER BY revision").bind(user.id, gid, rev - SAVE_KEEP).all<{ revision: number; r2_key: string }>();
  for (const o of old.results) { await env.DB.prepare("DELETE FROM cloud_saves WHERE user_id = ? AND game_id = ? AND revision = ?").bind(user.id, gid, o.revision).run(); await bucket(env).delete(o.r2_key).catch(() => {}); }
  const row = await head(env, user.id, gid);
  return json({ ok: true, revision: rev, head: row ? saveInfo(row) : null });
}

// ---------------------------------------------------------------- delete all Cloud data of an account (also used by the account deletion path)
export async function purgeCloudData(env: Env, uid: string): Promise<{ objects: number }> {
  let objects = 0;
  if (env.STORE) objects = (await deleteByPrefix(env, filesPrefix(uid))) + (await deleteByPrefix(env, savesPrefix(uid)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_upload_parts WHERE upload_id IN (SELECT id FROM cloud_uploads WHERE user_id = ?)").bind(uid),
    env.DB.prepare("DELETE FROM cloud_uploads WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM cloud_files WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM cloud_saves WHERE user_id = ?").bind(uid),
  ]);
  return { objects };
}
async function purgeMine(env: Env, req: Request, user: User): Promise<Response> {
  const b = await readJson(req, 1024);
  if (b.confirm !== user.username) throw new HttpError(400, "confirmation_required", "send {confirm: <your username>}");
  const r = await r2(() => purgeCloudData(env, user.id));
  logEvent("cloud_data_purged", { objects: r.objects });
  return json({ ok: true, deletedObjects: r.objects });
}
