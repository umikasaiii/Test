// R2 (private Cloud storage) is OPTIONAL: the same API surface is exercised with the STORE binding present (R2_ENABLED=true) and absent (R2_ENABLED=false).
// Without R2 every file / save route answers 503 STORAGE_NOT_CONFIGURED (an application error, never a crash) and everything else keeps working:
// accounts, friends, presence, rooms, signaling, Internet multiplayer (ICE), Party Voice, the library metadata and the deletion of an account.
import { describe, expect, it } from "vitest";
import { env, newAccount, befriend, ORIGIN } from "./helpers";
import worker from "../src/index";

const via = (enabled: boolean, token: string | null, method: string, path: string, body?: unknown) => {
  const e = { ...env, STORE: enabled ? env.STORE : undefined } as any;
  const h: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }; if (token) h.authorization = `Bearer ${token}`;
  return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e);
};
const j = async (r: Response) => { try { return await r.json() as any; } catch { return {}; } };

describe.each([true, false])("R2_ENABLED=%s", (R2) => {
  it("/api/config tells the app whether private Cloud storage exists", async () => {
    const c = await j(await via(R2, null, "GET", "/api/config"));
    expect(c.storage).toBe(R2 ? "r2" : "none");
    expect(Array.isArray(c.iceServers)).toBe(true);
  });

  it("the routes that store files answer " + (R2 ? "normally" : "503 STORAGE_NOT_CONFIGURED without crashing"), async () => {
    const a = await newAccount();
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/storage"], ["GET", "/api/files"], ["GET", "/api/saves"], ["POST", "/api/files/uploads", { kind: "game", name: "nds-abcd", size: 10 }],
      ["PUT", "/api/saves/nds-abcd?base=0&device=d&name=n"], ["GET", "/api/saves/nds-abcd/data"], ["DELETE", "/api/files"],
      ["POST", "/api/library/games", { title: "x", files: [{ name: "a.nds", size: 10 }] }], ["PUT", "/api/library/system/ps1/scph1001.bin"], ["DELETE", "/api/library/games/abcdef"],
    ];
    for (const [m, p, b] of calls) {
      const r = await via(R2, a.token, m, p, b);
      if (R2) expect(r.status, `${m} ${p}`).toBeLessThan(500);
      else { expect(r.status, `${m} ${p}`).toBe(503); expect((await j(r)).error).toBe("STORAGE_NOT_CONFIGURED"); }
    }
  });

  it("no Cloudflare detail reaches the caller", async () => {
    const a = await newAccount();
    const t = await (await via(R2, a.token, "GET", "/api/files/game/nds-none")).text();
    for (const s of ["R2", "bucket", "10042", "wrangler", "Cloudflare", "Please enable"]) expect(t).not.toContain(s);
  });

  it("accounts, friends, presence, ICE (Internet multiplayer) and Party Voice work either way", async () => {
    const a = await newAccount(), b = await newAccount();
    expect((await via(R2, a.token, "GET", "/api/me")).status).toBe(200);
    expect((await via(R2, null, "GET", "/api/health")).status).toBe(200);
    await befriend(a, b);
    const fr = await j(await via(R2, a.token, "GET", "/api/friends"));
    expect(fr.friends.map((f: any) => f.id ?? f.userId)).toContain(b.id);
    const ice = await via(R2, a.token, "GET", "/api/realtime/ice"); expect(ice.status).toBe(200);
    expect((await j(ice)).policy.relayAvailable).toBe(false);                                   // TURN stays optional and unconfigured
    expect((await via(R2, a.token, "POST", "/api/party")).status).toBe(201);
    expect((await via(R2, a.token, "GET", "/api/party/me")).status).toBe(200);
    expect((await via(R2, a.token, "POST", "/api/party/leave")).status).toBe(200);
    expect((await via(R2, a.token, "GET", "/api/library")).status).toBe(200);                   // library METADATA lives in D1
    expect((await via(R2, a.token, "POST", "/api/ws-ticket")).status).toBe(200);
  });

  it("signaling rooms (code + QR join) work either way", async () => {
    const r = await via(R2, null, "POST", "/signal/create", {});
    expect(r.status).toBe(200); expect((await j(r)).code ?? (await j(r))).toBeTruthy();
  });

  it("deleting an account works either way (nothing to purge in R2 when it is absent)", async () => {
    const a = await newAccount();
    const r = await via(R2, a.token, "DELETE", "/api/account", { confirm: a.username });
    expect(r.status).toBe(200); expect((await j(r)).deletedObjects).toBe(0);
    expect((await via(R2, a.token, "GET", "/api/me")).status).toBe(401);
  });
});
