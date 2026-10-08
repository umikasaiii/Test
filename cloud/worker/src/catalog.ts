// Library METADATA in the cloud + the generic game catalog. The cloud knows WHICH games an account has (title, platform, product code, ...), never the files:
// ROMs, BIOS, firmware and saves stay on the devices. The same account on two phones sees the same list; each phone shows "GIOCA" only if it holds the file.
import type { Env, User } from "./env";
import { HttpError, json, now, readJson, str } from "./util";
import { profileOf } from "./netprofile";

const ID_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const PLATFORM_RE = /^[a-z0-9]{2,12}$/;
export const MP_MODES = ["none", "distributed", "download_play", "both"];

interface Row { game_id: string; platform: string; title: string; product_code: string; core_id: string; multiplayer_mode: string; download_play_supported: number; metadata_version: number; favorite: number; last_played: number; added_at: number; net_override?: string | null; file_size?: number | null; file_sha?: string | null; save_rev?: number | null }
const toEntry = (r: Row) => ({ gameId: r.game_id, platform: r.platform, title: r.title, productCode: r.product_code, coreId: r.core_id, multiplayerMode: r.multiplayer_mode, downloadPlaySupported: !!r.download_play_supported,
  metadataVersion: r.metadata_version, favorite: !!r.favorite, lastPlayed: r.last_played || null, addedAt: r.added_at,
  networkProfile: profileOf({ productCode: r.product_code, downloadPlaySupported: !!r.download_play_supported, override: r.net_override ?? "" }),
  cloudFile: r.file_size ? { size: r.file_size, sha256: r.file_sha } : null, cloudSaveRevision: r.save_rev ?? null });

/** the catalog is shared by all accounts, so the descriptive fields are validated and only ever grow more precise: a client can add a game, not rewrite someone else's title with junk */
function validEntry(b: Record<string, unknown>) {
  const gameId = str(b.gameId, "gameId", 3, 40).toLowerCase();
  if (!ID_RE.test(gameId)) throw new HttpError(400, "invalid_gameId", "a-z 0-9 _ - (3-40)");
  const platform = str(b.platform, "platform", 2, 12).toLowerCase();
  if (!PLATFORM_RE.test(platform)) throw new HttpError(400, "invalid_platform");
  const title = str(b.title, "title", 1, 80).replace(/[\u0000-\u001f<>]/g, "").trim();
  if (!title) throw new HttpError(400, "invalid_title");
  const productCode = b.productCode === undefined ? "" : str(b.productCode, "productCode", 0, 16).replace(/[^A-Za-z0-9_-]/g, "");
  const coreId = b.coreId === undefined ? "" : str(b.coreId, "coreId", 0, 32).replace(/[^a-z0-9_.-]/gi, "");
  const mode = b.multiplayerMode === undefined ? "none" : str(b.multiplayerMode, "multiplayerMode", 1, 16);
  if (!MP_MODES.includes(mode)) throw new HttpError(400, "invalid_multiplayerMode");
  return { gameId, platform, title, productCode, coreId, mode, dl: b.downloadPlaySupported === true ? 1 : 0, favorite: b.favorite === true ? 1 : 0 };
}

export async function handleCatalog(env: Env, req: Request, path: string, user: User): Promise<Response | null> {
  const m = req.method;
  if (m === "GET" && path === "/api/cloud/library") {
    const rows = await env.DB.prepare(
      `SELECT g.game_id, g.platform, g.title, g.product_code, g.core_id, g.multiplayer_mode, g.download_play_supported, g.metadata_version, e.favorite, e.last_played, e.added_at, g.network_profile AS net_override,
       (SELECT size FROM cloud_files c WHERE c.user_id = e.user_id AND c.kind = 'game' AND c.name = e.game_id) AS file_size,
       (SELECT sha256 FROM cloud_files c WHERE c.user_id = e.user_id AND c.kind = 'game' AND c.name = e.game_id) AS file_sha,
       (SELECT revision FROM cloud_saves s WHERE s.user_id = e.user_id AND s.game_id = e.game_id ORDER BY revision DESC LIMIT 1) AS save_rev
       FROM library_entries e JOIN game_metadata g ON g.game_id = e.game_id WHERE e.user_id = ? ORDER BY e.favorite DESC, g.title COLLATE NOCASE`).bind(user.id).all<Row>();
    return json({ entries: rows.results.map(toEntry) });
  }
  if (m === "PUT" && path === "/api/cloud/library") {           // add / update ONE entry (idempotent); the batch form below is what a device uses to sync its whole library
    const e = validEntry(await readJson(req));
    await upsert(env, user.id, e);
    return json({ ok: true, gameId: e.gameId });
  }
  if (m === "POST" && path === "/api/cloud/library/sync") {      // a device pushes the metadata of its local library; entries it does not mention are kept (other devices may own them)
    const b = await readJson(req, 128 * 1024);
    if (!Array.isArray(b.entries) || b.entries.length > 200) throw new HttpError(400, "invalid_entries");
    const items = b.entries.map((x) => validEntry(x as Record<string, unknown>));
    for (const e of items) await upsert(env, user.id, e);
    return json({ ok: true, count: items.length });
  }
  const mm = path.match(/^\/api\/cloud\/library\/([a-z0-9][a-z0-9_-]{2,39})(?:\/(favorite|played))?$/);
  if (mm) {
    const [, id, act] = mm;
    if (m === "DELETE" && !act) {
      const r = await env.DB.prepare("DELETE FROM library_entries WHERE user_id = ? AND game_id = ?").bind(user.id, id).run();
      if (!r.meta.changes) throw new HttpError(404, "entry_not_found");
      return json({ ok: true });
    }
    if (m === "POST" && act === "favorite") {
      const b = await readJson(req);
      const r = await env.DB.prepare("UPDATE library_entries SET favorite = ? WHERE user_id = ? AND game_id = ?").bind(b.favorite === true ? 1 : 0, user.id, id).run();
      if (!r.meta.changes) throw new HttpError(404, "entry_not_found");
      return json({ ok: true });
    }
    if (m === "POST" && act === "played") {
      const r = await env.DB.prepare("UPDATE library_entries SET last_played = ? WHERE user_id = ? AND game_id = ?").bind(now(), user.id, id).run();
      if (!r.meta.changes) throw new HttpError(404, "entry_not_found");
      return json({ ok: true });
    }
  }
  if (m === "GET" && path === "/api/catalog") {                   // read-only view of the shared catalog (no per-user data)
    const rows = await env.DB.prepare("SELECT game_id, platform, title, product_code, core_id, multiplayer_mode, download_play_supported, metadata_version, network_profile AS net_override, 0 AS favorite, 0 AS last_played, updated_at AS added_at FROM game_metadata ORDER BY title COLLATE NOCASE LIMIT 500").all<Row>();
    return json({ games: rows.results.map(toEntry) });
  }
  return null;
}

async function upsert(env: Env, userId: string, e: ReturnType<typeof validEntry>) {
  const t = now();
  await env.DB.batch([
    // an existing catalog row keeps its title/product code (first writer wins); capabilities may be raised, never silently lowered by one client
    env.DB.prepare(`INSERT INTO game_metadata (game_id, platform, title, product_code, core_id, multiplayer_mode, download_play_supported, metadata_version, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)
      ON CONFLICT(game_id) DO UPDATE SET download_play_supported = MAX(download_play_supported, excluded.download_play_supported),
        multiplayer_mode = CASE WHEN game_metadata.multiplayer_mode = 'none' THEN excluded.multiplayer_mode ELSE game_metadata.multiplayer_mode END,
        core_id = CASE WHEN game_metadata.core_id = '' THEN excluded.core_id ELSE game_metadata.core_id END, updated_at = ?8`).bind(e.gameId, e.platform, e.title, e.productCode, e.coreId, e.mode, e.dl, t),
    env.DB.prepare("INSERT INTO library_entries (user_id, game_id, favorite, last_played, added_at) VALUES (?1,?2,?3,0,?4) ON CONFLICT(user_id, game_id) DO UPDATE SET favorite = excluded.favorite").bind(userId, e.gameId, e.favorite, t),
  ]);
}

/** a game whose file just reached the account's Cloud also exists in the account's library metadata (nothing is overwritten: a title or favourite set before stays) */
export async function upsertCatalog(env: Env, userId: string, gameId: string, title: string) {
  const t = now(), code = gameId.replace(/^[a-z0-9]+-/, "").toUpperCase(), platform = gameId.split("-")[0];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO game_metadata (game_id, platform, title, product_code, core_id, multiplayer_mode, download_play_supported, metadata_version, updated_at) VALUES (?1,?2,?3,?4,'melonds-ds','distributed',0,1,?5) ON CONFLICT(game_id) DO NOTHING").bind(gameId, platform, (title || code).slice(0, 80), code, t),
    env.DB.prepare("INSERT INTO library_entries (user_id, game_id, favorite, last_played, added_at) VALUES (?1,?2,0,0,?3) ON CONFLICT(user_id, game_id) DO NOTHING").bind(userId, gameId, t),
  ]);
}
