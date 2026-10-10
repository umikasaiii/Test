import { describe, expect, it } from "vitest";
import { api, env, makeNds, newAccount, ORIGIN } from "./helpers";
import { crc16 } from "../src/detect";
import { b64url } from "../src/util";
import worker from "../src/index";

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");
const MiB = 2 ** 20;
/** a valid NDS ROM with a given 4-letter product code and a deterministic payload */
function rom(code: string, size = 4096, seed = 7): Uint8Array<ArrayBuffer> {
  const b = makeNds("TESTROM", size, seed);
  for (let i = 0; i < 4; i++) b[12 + i] = code.charCodeAt(i);
  const c = crc16(b.subarray(0, 0x15e)); b[0x15e] = c & 255; b[0x15f] = c >> 8;
  for (let i = 0x200; i < size; i += 4099) b[i] = (i * seed) & 255;
  return b;
}
const gameId = (code: string) => "nds-" + code.toLowerCase();

async function upload(token: string, kind: "game" | "system", name: string, data: Uint8Array<ArrayBuffer>, extra: Record<string, unknown> = {}) {
  const init = await api("POST", "/api/files/uploads", { token, body: { kind, name, size: data.length, sha256: await hex(data), header: kind === "game" ? b64url(data.subarray(0, 512)) : undefined, title: "My Game", ...extra } });
  if (init.status !== 201) return { init };
  const { uploadId, chunkSize, partsTotal } = init.body;
  for (let n = 1; n <= partsTotal; n++) {
    const p = await api("PUT", `/api/files/uploads/${uploadId}/parts/${n}`, { token, raw: data.slice((n - 1) * chunkSize, n * chunkSize) });
    if (p.status !== 200) return { init, part: p };
  }
  const done = await api("POST", `/api/files/uploads/${uploadId}/complete`, { token });
  return { init, done, uploadId };
}
const objectsOf = async (uid: string) => (await env.STORE.list({ prefix: `u/${uid}/` })).objects.length;

describe("Cloud files: private ROM / system storage", () => {
  it("uploads a ROM, lists it, streams it back identical (Range works), creates the library metadata and counts the space", async () => {
    const a = await newAccount(); const data = rom("AMPS", 300_000);
    const r = await upload(a.token, "game", gameId("AMPS"), data);
    expect(r.init.status).toBe(201); expect(r.init.body.mode).toBe("single"); expect(r.done!.status).toBe(200);
    const list = await api("GET", "/api/files", { token: a.token });
    expect(list.body.games).toEqual([expect.objectContaining({ gameId: "nds-amps", size: 300_000, sha256: await hex(data) })]);
    const dl = await api("GET", "/api/files/game/nds-amps", { token: a.token });
    expect(dl.status).toBe(200); expect(await hex(dl.bytes)).toBe(await hex(data));
    expect(dl.headers.get("content-type")).toBe("application/octet-stream"); expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toBe("attachment"); expect(dl.headers.get("cache-control")).toContain("no-store");
    const part = await api("GET", "/api/files/game/nds-amps", { token: a.token, headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206); expect(part.headers.get("content-range")).toBe("bytes 100-199/300000"); expect(Array.from(part.bytes)).toEqual(Array.from(data.subarray(100, 200)));
    expect((await api("GET", "/api/files/game/nds-amps", { token: a.token, headers: { range: "bytes=999999-" } })).status).toBe(416);
    const lib = await api("GET", "/api/cloud/library", { token: a.token });
    expect(lib.body.entries[0]).toMatchObject({ gameId: "nds-amps", cloudFile: { size: 300_000 }, cloudSaveRevision: null });
    const st = await api("GET", "/api/storage", { token: a.token });
    expect(st.body).toMatchObject({ usedBytes: 300_000, gamesBytes: 300_000, games: 1 }); expect(st.body.quotaBytes).toBe(40 * MiB);
  });

  it("uploads a big ROM in parts (multipart), resumes after an interruption and verifies the hash", async () => {
    const a = await newAccount(); const data = rom("BIGG", 17 * MiB, 11);
    const init = await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "game", name: "nds-bigg", size: data.length, sha256: await hex(data), header: b64url(data.subarray(0, 512)) } });
    expect(init.body.mode).toBe("multipart"); expect(init.body.partsTotal).toBe(3);
    const id = init.body.uploadId, cs = init.body.chunkSize;
    expect((await api("PUT", `/api/files/uploads/${id}/parts/1`, { token: a.token, raw: data.slice(0, cs) })).status).toBe(200);
    // ... connection lost: ask what the Cloud already has and continue from there
    const st = await api("GET", `/api/files/uploads/${id}`, { token: a.token });
    expect(st.body.parts).toEqual([1]);
    expect((await api("POST", `/api/files/uploads/${id}/complete`, { token: a.token })).body).toMatchObject({ error: "parts_missing", missing: [2, 3] });
    for (const n of [2, 3]) expect((await api("PUT", `/api/files/uploads/${id}/parts/${n}`, { token: a.token, raw: data.slice((n - 1) * cs, n * cs) })).status).toBe(200);
    const done = await api("POST", `/api/files/uploads/${id}/complete`, { token: a.token });
    expect(done.status).toBe(200);
    const dl = await api("GET", "/api/files/game/nds-bigg", { token: a.token });
    expect(dl.bytes.length).toBe(data.length); expect(await hex(dl.bytes)).toBe(await hex(data));
  });

  it("deduplicates per account and replaces a changed file without leaving the old object behind", async () => {
    const a = await newAccount(); const d1 = rom("DUPE", 50_000, 3), d2 = rom("DUPE", 60_000, 5);
    await upload(a.token, "game", "nds-dupe", d1);
    const again = await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "game", name: "nds-dupe", size: d1.length, sha256: await hex(d1), header: b64url(d1.subarray(0, 512)) } });
    expect(again.body).toMatchObject({ done: true, deduplicated: true });
    expect(await objectsOf(a.id)).toBe(1);
    const r = await upload(a.token, "game", "nds-dupe", d2); expect(r.done!.status).toBe(200);
    expect(await objectsOf(a.id)).toBe(1);                                                                    // the old object was deleted
    expect((await api("GET", "/api/files/game/nds-dupe", { token: a.token })).bytes.length).toBe(60_000);
  });

  it("stores BIOS and firmware privately (only the expected names and sizes)", async () => {
    const a = await newAccount();
    for (const [name, size] of [["bios7.bin", 16384], ["bios9.bin", 4096], ["firmware.bin", 262144]] as const) {
      const d = new Uint8Array(size).map((_, i) => (i * 31 + size) & 255);
      expect((await upload(a.token, "system", name, d)).done!.status).toBe(200);
      expect(await hex((await api("GET", `/api/files/system/${name}`, { token: a.token })).bytes)).toBe(await hex(d));
    }
    expect((await api("GET", "/api/files", { token: a.token })).body.system.map((s: any) => s.name)).toEqual(["bios7.bin", "bios9.bin", "firmware.bin"]);
    const wrong = await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "system", name: "bios7.bin", size: 100, sha256: "0".repeat(64) } });
    expect(wrong.status).toBe(422);
    expect((await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "system", name: "refs.json", size: 100, sha256: "0".repeat(64) } })).status).toBe(400);
    expect((await api("DELETE", "/api/files/system/bios9.bin", { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/files/system/bios9.bin", { token: a.token })).status).toBe(404);
  });

  it("refuses malformed, spoofed and oversized files and bad names (no path traversal, no content-type tricks)", async () => {
    const a = await newAccount(); const good = rom("OKAY", 4096);
    const init = (body: Record<string, unknown>) => api("POST", "/api/files/uploads", { token: a.token, body });
    const base = { kind: "game", name: "nds-okay", size: good.length, sha256: await hex(good), header: b64url(good.subarray(0, 512)) };
    expect((await init(base)).status).toBe(201);
    expect((await init({ ...base, header: b64url(new Uint8Array(512).fill(1)) })).status).toBe(415);            // a renamed non-ROM
    expect((await init({ ...base, header: undefined })).status).toBe(415);
    expect((await init({ ...base, name: "nds-zzzz" })).status).toBe(422);                                       // the id must match the ROM's own product code
    for (const bad of ["../etc/passwd", "nds-okay/../x", "NDS OKAY", "nds-okay%2f..", "u/other/cf", ""]) expect((await init({ ...base, name: bad })).status).toBe(400);
    expect((await init({ ...base, sha256: "xyz" })).status).toBe(400);
    expect((await init({ ...base, size: 0 })).status).toBe(400);
    expect((await init({ ...base, size: 600 * MiB })).status).toBe(413);
    expect((await init({ ...base, kind: "avatar" })).status).toBe(400);
    expect((await api("GET", "/api/files/game/..%2F..%2Fx", { token: a.token })).status).toBe(404);
    expect((await api("GET", "/api/files/game/nds-okay%00", { token: a.token })).status).toBe(404);
    // an HTML file served back is still an attachment of octet-stream, never rendered
    const rr = await upload(a.token, "game", "nds-okay", good, { }); void rr;
    const dl = await api("GET", "/api/files/game/nds-okay", { token: a.token, headers: { accept: "text/html" } });
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("detects a corrupted upload (hash mismatch) and a wrong part size, and cleans up", async () => {
    const a = await newAccount(); const d = rom("HASH", 100_000);
    const claimed = rom("HASH", 100_000, 9);                                                                   // same size, other content
    const init = await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "game", name: "nds-hash", size: d.length, sha256: await hex(claimed), header: b64url(d.subarray(0, 512)) } });
    const id = init.body.uploadId;
    expect((await api("PUT", `/api/files/uploads/${id}/parts/1`, { token: a.token, raw: d.slice(0, 5000) })).status).toBe(400);   // wrong part length
    expect((await api("PUT", `/api/files/uploads/${id}/parts/2`, { token: a.token, raw: d })).status).toBe(400);                    // no such part
    expect((await api("PUT", `/api/files/uploads/${id}/parts/1`, { token: a.token, raw: d })).status).toBe(200);
    const done = await api("POST", `/api/files/uploads/${id}/complete`, { token: a.token });
    expect(done.status).toBe(422); expect(done.body.error).toBe("hash_mismatch");
    expect(await objectsOf(a.id)).toBe(0);
    expect((await api("GET", "/api/files", { token: a.token })).body.games).toHaveLength(0);
    expect((await api("GET", `/api/files/uploads/${id}`, { token: a.token })).status).toBe(404);
  });

  it("CROSS-ACCOUNT: another account cannot list, read, delete, resume, finish or overwrite anything (IDOR)", async () => {
    const a = await newAccount(), b = await newAccount(); const d = rom("PRIV", 80_000);
    await upload(a.token, "game", "nds-priv", d);
    await upload(a.token, "system", "bios7.bin", new Uint8Array(16384).fill(9));
    const pend = await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "game", name: "nds-priv", size: 80_001, sha256: "a".repeat(64), header: b64url(d.subarray(0, 512)) } });
    const pid = pend.body.uploadId;
    expect((await api("GET", "/api/files", { token: b.token })).body).toMatchObject({ games: [], system: [] });
    expect((await api("GET", "/api/files/game/nds-priv", { token: b.token })).status).toBe(404);
    expect((await api("GET", "/api/files/system/bios7.bin", { token: b.token })).status).toBe(404);
    expect((await api("DELETE", "/api/files/game/nds-priv", { token: b.token })).status).toBe(404);
    for (const [m, p] of [["GET", `/api/files/uploads/${pid}`], ["PUT", `/api/files/uploads/${pid}/parts/1`], ["POST", `/api/files/uploads/${pid}/complete`], ["DELETE", `/api/files/uploads/${pid}`]] as const)
      expect((await api(m, p, { token: b.token, raw: m === "PUT" ? new Uint8Array(80_001) : undefined })).status, `${m} ${p}`).toBe(404);
    expect((await api("GET", "/api/files/game/nds-priv", { token: a.token })).status).toBe(200);                    // untouched
    // saves: another account's save revisions are invisible; its own PUT never touches A's history
    const sv = new Uint8Array(1000).fill(4);
    await api("PUT", `/api/saves/nds-priv?base=0&device=devA-111111`, { token: a.token, raw: sv });
    expect((await api("GET", "/api/saves/nds-priv/data", { token: b.token })).status).toBe(404);
    expect((await api("GET", "/api/saves/nds-priv", { token: b.token })).body.history).toEqual([]);
    expect((await api("POST", "/api/saves/nds-priv/restore", { token: b.token, body: { revision: 1, device: "devB-222222" } })).status).toBe(404);
    expect((await api("GET", "/api/saves/nds-priv", { token: a.token })).body.history).toHaveLength(1);
    // the bucket itself: every object of A lives under A's own prefix, none under B's
    expect(await objectsOf(b.id)).toBe(0); expect(await objectsOf(a.id)).toBeGreaterThan(0);
    // anonymous
    for (const p of ["/api/files", "/api/files/game/nds-priv", "/api/saves", "/api/storage"]) expect((await api("GET", p)).status).toBe(401);
  });

  it("enforces the Cloud quota and reports it; local state is untouched by a Cloud error", async () => {
    const a = await newAccount();
    expect((await upload(a.token, "game", "nds-qa01", rom("QA01", 17 * MiB, 1))).done!.status).toBe(200);
    expect((await upload(a.token, "game", "nds-qa02", rom("QA02", 17 * MiB, 2))).done!.status).toBe(200);
    const third = await upload(a.token, "game", "nds-qa03", rom("QA03", 17 * MiB, 3));
    expect(third.init.status).toBe(507); expect(third.init.body.error).toBe("cloud_quota_exceeded");
    const st = await api("GET", "/api/storage", { token: a.token });
    expect(st.body.usedBytes).toBe(34 * MiB);
    const big = await api("PUT", "/api/saves/nds-qa01?base=0&device=devA-111111", { token: a.token, raw: new Uint8Array(7 * MiB).fill(1) });
    expect(big.status).toBe(507);                                                                          // a save does not fit either: reported, nothing stored
    expect((await api("GET", "/api/saves/nds-qa01", { token: a.token })).body.history).toHaveLength(0);
  });

  it("rate limits upload requests per account", async () => {
    const a = await newAccount(); let last = 0;
    for (let i = 0; i < 45; i++) last = (await api("POST", "/api/files/uploads", { token: a.token, body: { kind: "avatar" } })).status;
    expect(last).toBe(429);
  });

  it("reports R2 problems (no binding: STORAGE_NOT_CONFIGURED; R2 failing: storage_unavailable) without leaking anything", async () => {
    const a = await newAccount(); const d = rom("DOWN", 5000);
    const req = (e: any, method: string, path: string, body?: any) => worker.fetch(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${a.token}`, origin: ORIGIN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e);
    const noBucket = { ...env, STORE: undefined } as any;
    const r1 = await req(noBucket, "POST", "/api/files/uploads", { kind: "game", name: "nds-down", size: d.length, sha256: await hex(d), header: b64url(d.subarray(0, 512)) });
    expect(r1.status).toBe(503); expect((await r1.json() as any).error).toBe("STORAGE_NOT_CONFIGURED");
    const broken = { ...env, STORE: { put: async () => { throw new Error("R2 exploded for u/secret/cf/game/abc"); }, get: async () => { throw new Error("boom"); }, head: async () => { throw new Error("boom"); }, delete: async () => { throw new Error("boom"); } } } as any;
    await upload(a.token, "game", "nds-down", d);
    const r2 = await req(broken, "GET", "/api/files/game/nds-down");
    expect(r2.status).toBe(503); const t = await r2.text(); expect(t).not.toContain("boom"); expect(t).not.toContain("u/");
    expect((await api("GET", "/api/files", { token: a.token })).body.games).toHaveLength(1);                   // metadata and the object are still fine
  });

  it("DELETE /api/files removes every Cloud file and save of the account (account-delete preparation) and deleting the account too", async () => {
    const a = await newAccount();
    await upload(a.token, "game", "nds-purg", rom("PURG", 20_000)); await upload(a.token, "system", "bios9.bin", new Uint8Array(4096).fill(2));
    await api("PUT", "/api/saves/nds-purg?base=0&device=devA-111111", { token: a.token, raw: new Uint8Array(500).fill(3) });
    expect(await objectsOf(a.id)).toBe(3);
    expect((await api("DELETE", "/api/files", { token: a.token, body: { confirm: "nope" } })).status).toBe(400);
    expect(await objectsOf(a.id)).toBe(3);
    const r = await api("DELETE", "/api/files", { token: a.token, body: { confirm: a.username } });
    expect(r.body.deletedObjects).toBe(3); expect(await objectsOf(a.id)).toBe(0);
    expect((await api("GET", "/api/storage", { token: a.token })).body).toMatchObject({ usedBytes: 0, games: 0 });
    // account deletion wipes it too
    const c = await newAccount(); await upload(c.token, "game", "nds-gone", rom("GONE", 20_000));
    await api("PUT", "/api/saves/nds-gone?base=0&device=devA-111111", { token: c.token, raw: new Uint8Array(500).fill(3) });
    expect((await api("DELETE", "/api/account", { token: c.token, body: { confirm: c.username } })).status).toBe(200);
    expect(await objectsOf(c.id)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_files WHERE user_id = ?").bind(c.id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_saves WHERE user_id = ?").bind(c.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("Cloud saves: revisions, conflicts, restore", () => {
  const put = (t: string, gid: string, data: Uint8Array, q: string) => api("PUT", `/api/saves/${gid}?${q}`, { token: t, raw: data });
  const sv = (n: number, size = 2048) => new Uint8Array(size).fill(n);

  it("uploads, downloads and versions a save; an unchanged save is not a new revision; only the last 5 are kept", async () => {
    const a = await newAccount();
    const r1 = await put(a.token, "nds-sav1", sv(1), "base=0&device=honor-1111&name=Honor");
    expect(r1.body).toMatchObject({ ok: true, revision: 1 });
    expect((await put(a.token, "nds-sav1", sv(1), "base=1&device=iphone-2222&name=iPhone")).body).toMatchObject({ unchanged: true, revision: 1 });
    expect((await api("GET", "/api/saves/nds-sav1/data", { token: a.token })).bytes[0]).toBe(1);
    for (let i = 2; i <= 7; i++) expect((await put(a.token, "nds-sav1", sv(i), `base=${i - 1}&device=honor-1111&name=Honor`)).body.revision).toBe(i);
    const h = await api("GET", "/api/saves/nds-sav1", { token: a.token });
    expect(h.body.history.map((x: any) => x.revision)).toEqual([7, 6, 5, 4, 3]);
    expect(h.body.head).toMatchObject({ revision: 7, deviceName: "Honor", size: 2048 });
    expect(await objectsOf(a.id)).toBe(5);                                                                     // pruned objects are really deleted
    expect((await api("GET", "/api/saves", { token: a.token })).body.saves).toEqual([expect.objectContaining({ gameId: "nds-sav1", revision: 7 })]);
    expect((await api("GET", "/api/cloud/library", { token: a.token })).body.entries).toEqual([]);              // saves alone do not invent library entries
  });

  it("never overwrites silently: a stale base is a conflict that names the other device; force resolves it", async () => {
    const a = await newAccount();
    await put(a.token, "nds-cnf1", sv(1), "base=0&device=honor-1111&name=Honor");
    await put(a.token, "nds-cnf1", sv(2), "base=1&device=honor-1111&name=Honor");           // Honor moved on to revision 2
    const c = await put(a.token, "nds-cnf1", sv(9), "base=1&device=iphone-2222&name=iPhone"); // the iPhone still believes the head is 1
    expect(c.status).toBe(409); expect(c.body.error).toBe("save_conflict");
    expect(c.body.head).toMatchObject({ revision: 2, deviceName: "Honor" }); expect(c.body.head.updatedAt).toBeGreaterThan(0);
    expect((await api("GET", "/api/saves/nds-cnf1/data", { token: a.token })).bytes[0]).toBe(2);              // the Cloud copy was not touched
    const f = await put(a.token, "nds-cnf1", sv(9), "base=2&device=iphone-2222&name=iPhone&force=1");           // "USA QUESTO": the iPhone's save wins, Honor's stays in the history
    expect(f.body.revision).toBe(3);
    expect((await api("GET", "/api/saves/nds-cnf1/data?rev=2", { token: a.token })).bytes[0]).toBe(2);
  });

  it("two devices writing the same next revision at once: one wins, the other gets a conflict", async () => {
    const a = await newAccount(); await put(a.token, "nds-race", sv(1), "base=0&device=honor-1111");
    const [x, y] = await Promise.all([put(a.token, "nds-race", sv(2), "base=1&device=honor-1111"), put(a.token, "nds-race", sv(3), "base=1&device=iphone-2222")]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await api("GET", "/api/saves/nds-race", { token: a.token })).body.history).toHaveLength(2);
  });

  it("restores an older revision as a new revision (history stays linear, nothing lost) and can delete the history", async () => {
    const a = await newAccount();
    for (let i = 1; i <= 3; i++) await put(a.token, "nds-rst1", sv(i), `base=${i - 1}&device=honor-1111&name=Honor`);
    const r = await api("POST", "/api/saves/nds-rst1/restore", { token: a.token, body: { revision: 1, device: "iphone-2222", name: "iPhone" } });
    expect(r.body).toMatchObject({ ok: true, revision: 4 }); expect(r.body.head.note).toBe("restore:1");
    expect((await api("GET", "/api/saves/nds-rst1/data", { token: a.token })).bytes[0]).toBe(1);
    expect((await api("GET", "/api/saves/nds-rst1/data?rev=3", { token: a.token })).bytes[0]).toBe(3);
    expect((await api("POST", "/api/saves/nds-rst1/restore", { token: a.token, body: { revision: 99, device: "iphone-2222" } })).status).toBe(404);
    expect((await api("DELETE", "/api/saves/nds-rst1", { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/saves/nds-rst1", { token: a.token })).body.history).toEqual([]);
    expect(await objectsOf(a.id)).toBe(0);
  });

  it("validates saves: size, hash, device id, game id", async () => {
    const a = await newAccount();
    expect((await put(a.token, "nds-val1", new Uint8Array(0), "base=0&device=honor-1111")).status).toBe(400);
    expect((await put(a.token, "nds-val1", new Uint8Array(9 * MiB), "base=0&device=honor-1111")).status).toBe(413);
    expect((await put(a.token, "nds-val1", sv(1), "base=0&device=honor-1111&sha=" + "0".repeat(64))).status).toBe(422);
    expect((await put(a.token, "nds-val1", sv(1), "base=0&device=../../x")).status).toBe(400);
    expect((await put(a.token, "nds-val1", sv(1), "base=-1&device=honor-1111")).status).toBe(400);
    expect((await put(a.token, "nds-val1", sv(1), "base=abc&device=honor-1111")).status).toBe(400);
    expect((await api("PUT", "/api/saves/..%2Fx?base=0&device=honor-1111", { token: a.token, raw: sv(1) })).status).toBe(404);
    expect((await api("PUT", "/api/saves/NDS_X?base=0&device=honor-1111", { token: a.token, raw: sv(1) })).status).toBe(404);
  });
});
