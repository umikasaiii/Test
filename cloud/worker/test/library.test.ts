import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { addGame, api, hdr, makeNds, newAccount } from "./helpers";
import { b64url } from "../src/util";

const list = async (a: { token: string }) => (await api("GET", "/api/library", { token: a.token })).body.games;
const r2Keys = async (prefix: string) => (await env.STORE.list({ prefix })).objects.map((o) => o.key);

describe("library: adding games", () => {
  it("adds a .nds from the device; platform is detected from the header, title from the cartridge header", async () => {
    const a = await newAccount();
    const rom = makeNds("MARIOPARTYDS", 8192);
    const r = await addGame(a, [{ name: "whatever-name.nds", data: rom }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, platform: "nds", title: "MARIOPARTYDS" });
    const g = await list(a);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ platform: "nds", title: "MARIOPARTYDS", size: 8192 });
    // bytes are stored byte-for-byte in R2 under the owner's prefix
    const keys = await r2Keys(`u/${a.id}/g/`);
    expect(keys).toHaveLength(1);
    expect(new Uint8Array(await (await env.STORE.get(keys[0]))!.arrayBuffer())).toEqual(rom);
  });

  it("rejects files that are not what their extension claims, and unknown types", async () => {
    const a = await newAccount();
    const junk = new Uint8Array(4096).fill(7);
    expect((await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "x.nds", size: junk.length, header: hdr(junk) }] } })).status).toBe(415);
    expect((await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "x.zip", size: 10, header: "" }] } })).status).toBe(415);
    expect((await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "x.chd", size: junk.length, header: hdr(junk) }] } })).status).toBe(415);
    expect((await api("POST", "/api/library/games", { token: a.token, body: { files: [] } })).status).toBe(400);
    expect(await list(a)).toHaveLength(0);
  });

  it("a client that lies in the header but uploads something else is caught at completion and nothing is kept", async () => {
    const a = await newAccount();
    const good = makeNds(), bad = new Uint8Array(4096).fill(9);
    const c = await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "g.nds", size: bad.length, header: hdr(good) }] } });
    expect(c.status).toBe(201);
    await api("PUT", c.body.uploads[0].url, { token: a.token, raw: bad, headers: { "content-length": String(bad.length) } });
    const done = await api("POST", `/api/library/games/${c.body.gameId}/complete`, { token: a.token });
    expect(done.status).toBe(422);
    expect(done.body.error).toBe("invalid_nds");
    expect(await r2Keys(`u/${a.id}/`)).toHaveLength(0);
    expect(await list(a)).toHaveLength(0);
  });

  it("upload size must match the declaration", async () => {
    const a = await newAccount();
    const rom = makeNds();
    const c = await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "g.nds", size: rom.length + 10, header: hdr(rom) }] } });
    const p = await api("PUT", c.body.uploads[0].url, { token: a.token, raw: rom, headers: { "content-length": String(rom.length) } });
    expect(p.status).toBe(400);
  });

  it("accepts a CHD by magic and a CUE+BIN set whose cue references exactly the uploaded bins", async () => {
    const a = await newAccount();
    const chd = new Uint8Array(2048); chd.set(new TextEncoder().encode("MComprHD"));
    expect((await addGame(a, [{ name: "disc.chd", data: chd }])).body).toMatchObject({ ok: true, platform: "ps1" });
    const cue = new TextEncoder().encode('FILE "game (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE "game (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
    const t1 = new Uint8Array(2352 * 4).fill(1), t2 = new Uint8Array(2352 * 2).fill(2);
    const ok = await addGame(a, [{ name: "game.cue", data: cue as Uint8Array<ArrayBuffer> }, { name: "game (Track 1).bin", data: t1 }, { name: "game (Track 2).bin", data: t2 }]);
    expect(ok.body).toMatchObject({ ok: true, platform: "ps1" });
    const missing = await addGame(a, [{ name: "g2.cue", data: cue as Uint8Array<ArrayBuffer> }, { name: "game (Track 1).bin", data: t1 }]);
    expect(missing.status).toBe(422);
    expect(missing.body.error).toBe("cue_bin_mismatch");
    const bare = await api("POST", "/api/library/games", { token: a.token, body: { files: [{ name: "lonely.bin", size: 10, header: "" }] } });
    expect(bare.status).toBe(422);   // a .bin without its .cue is not a game
    expect((await list(a)).map((g: any) => g.platform).sort()).toEqual(["ps1", "ps1"]);
  });

  it("rename and delete (delete removes the R2 objects too)", async () => {
    const a = await newAccount();
    const r = await addGame(a, [{ name: "a.nds", data: makeNds("ORIG") }]);
    const id = r.body.gameId;
    expect((await api("PATCH", `/api/library/games/${id}`, { token: a.token, body: { title: "Il mio gioco" } })).body.title).toBe("Il mio gioco");
    expect((await list(a))[0].title).toBe("Il mio gioco");
    expect(await r2Keys(`u/${a.id}/`)).toHaveLength(1);
    expect((await api("DELETE", `/api/library/games/${id}`, { token: a.token })).status).toBe(200);
    expect(await list(a)).toHaveLength(0);
    expect(await r2Keys(`u/${a.id}/`)).toHaveLength(0);
  });
});

describe("library: privacy", () => {
  it("another user can neither see, change, delete, download nor save into someone else's game", async () => {
    const a = await newAccount(), b = await newAccount();
    const r = await addGame(a, [{ name: "a.nds", data: makeNds("PRIVATE") }]);
    const id = r.body.gameId;
    expect(await list(b)).toHaveLength(0);
    expect((await api("PATCH", `/api/library/games/${id}`, { token: b.token, body: { title: "hax" } })).status).toBe(404);
    expect((await api("DELETE", `/api/library/games/${id}`, { token: b.token })).status).toBe(404);
    expect((await api("PUT", `/api/library/games/${id}/save/sram`, { token: b.token, raw: new Uint8Array(100), headers: { "content-length": "100" } })).status).toBe(404);
    expect((await api("GET", `/api/library/games/${id}/save/sram`, { token: b.token })).status).toBe(404);
    expect((await list(a))[0].title).toBe("PRIVATE");
  });

  it("there is no route that serves a ROM or a BIOS back to a browser; the bucket is not publicly addressable", async () => {
    const a = await newAccount();
    const r = await addGame(a, [{ name: "a.nds", data: makeNds() }]);
    const key = (await r2Keys(`u/${a.id}/`))[0];
    for (const p of [`/${key}`, `/api/library/games/${r.body.gameId}`, `/api/library/games/${r.body.gameId}/files`, `/api/files/${key}`, `/api/library/system/nds/firmware.bin`]) {
      const g = await api("GET", p, { token: a.token });
      expect([404, 405].includes(g.status) || g.body?.files !== undefined).toBe(true);
      expect(typeof g.body === "string" ? g.body.includes("DSLINK") : false).toBe(false);
    }
    expect((await api("GET", `/${key}`)).status).toBe(404);   // unauthenticated
  });

  it("BIOS/firmware: validated by name and size, stored privately, listed as metadata only", async () => {
    const a = await newAccount(), b = await newAccount();
    const fw = new Uint8Array(262144).fill(3);
    const put = (n: string, d: Uint8Array<ArrayBuffer>, acc = a) => api("PUT", `/api/library/system/nds/${n}`, { token: acc.token, raw: d, headers: { "content-length": String(d.length) } });
    expect((await put("firmware.bin", fw)).status).toBe(200);
    expect((await put("bios7.bin", new Uint8Array(16384))).status).toBe(200);
    expect((await put("bios9.bin", new Uint8Array(100))).status).toBe(422);        // wrong size
    expect((await put("evil.exe", new Uint8Array(16384))).status).toBe(400);
    const l = await api("GET", "/api/library/system", { token: a.token });
    expect(l.body.files.map((f: any) => f.name).sort()).toEqual(["bios7.bin", "firmware.bin"]);
    expect(JSON.stringify(l.body)).not.toContain("r2");
    expect((await api("GET", "/api/library/system", { token: b.token })).body.files).toHaveLength(0);
    expect((await api("DELETE", "/api/library/system/nds/firmware.bin", { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/library/system", { token: a.token })).body.files.map((f: any) => f.name)).toEqual(["bios7.bin"]);
  });

  it("saves round-trip (export/import) and stay per owner", async () => {
    const a = await newAccount();
    const g = await addGame(a, [{ name: "a.nds", data: makeNds() }]);
    const sav = new Uint8Array(512).map((_, i) => i & 255);
    expect((await api("PUT", `/api/library/games/${g.body.gameId}/save/sram`, { token: a.token, raw: sav, headers: { "content-length": "512" } })).status).toBe(200);
    const got = await api("GET", `/api/library/games/${g.body.gameId}/save/sram`, { token: a.token });
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(sav);
    expect((await list(a))[0].hasSave).toBe(true);
    expect((await api("PUT", `/api/library/games/${g.body.gameId}/save/bogus`, { token: a.token, raw: sav, headers: { "content-length": "512" } })).status).toBe(400);
  });

  it("logs never carry file names or R2 keys", async () => {
    const lines: string[] = [];
    const orig = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const a = await newAccount();
      await addGame(a, [{ name: "SECRET-TITLE-123.nds", data: makeNds("SECRETTITLE") }]);
      await api("DELETE", "/api/account", { token: a.token, body: { confirm: a.username } });
    } finally { console.log = orig; }
    const all = lines.join("\n");
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain("u/");
  });
});

describe("account deletion", () => {
  it("deletes every row and R2 object of the user and invalidates the session; others are untouched", async () => {
    const a = await newAccount(), b = await newAccount();
    await addGame(a, [{ name: "a.nds", data: makeNds("A") }]);
    await addGame(b, [{ name: "b.nds", data: makeNds("B") }]);
    await api("PUT", "/api/library/system/nds/firmware.bin", { token: a.token, raw: new Uint8Array(262144), headers: { "content-length": "262144" } });
    expect(await r2Keys(`u/${a.id}/`)).toHaveLength(2);
    expect((await api("DELETE", "/api/account", { token: a.token, body: {} })).status).toBe(400);              // needs explicit confirmation
    const d = await api("DELETE", "/api/account", { token: a.token, body: { confirm: a.username } });
    expect(d.status).toBe(200);
    expect(d.body.deletedObjects).toBe(2);
    expect(await r2Keys(`u/${a.id}/`)).toHaveLength(0);
    expect((await api("GET", "/api/me", { token: a.token })).status).toBe(401);
    for (const t of ["users", "auth_sessions", "games", "system_files"]) {
      const col = t === "users" ? "id" : "user_id";
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).bind(a.id).first<any>()).n).toBe(0);
    }
    expect(await r2Keys(`u/${b.id}/`)).toHaveLength(1);
    expect(await list(b)).toHaveLength(1);
  });
});
