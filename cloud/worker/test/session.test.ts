import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { addGame, api, befriend, env, makeNds, newAccount, openPresence, until, type Account } from "./helpers";

async function pair() {
  const a = await newAccount(), b = await newAccount();
  await befriend(a, b);
  const rom = makeNds("MARIOPARTYDS", 6000);
  const g = await addGame(a, [{ name: "mp.nds", data: rom }]);
  return { a, b, rom, gameId: g.body.gameId as string };
}
const statusOf = async (v: Account, id: string) => (await api("GET", "/api/friends", { token: v.token })).body.friends.find((f: any) => f.userId === id)?.status;
const internalHdr = (ticket: string) => ({ authorization: "Bearer " + env.INTERNAL_TOKEN, "x-dslink-ticket": ticket });

describe("invites", () => {
  it("full flow: invite -> live notification -> accept -> session with Player 1 / Player 2", async () => {
    const { a, b, gameId } = await pair();
    const pa = await openPresence(a), pb = await openPresence(b);
    const inv = await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } });
    expect(inv.status).toBe(201);
    const ev = await until(() => pb.events.find((e) => e.t === "invite"));
    expect(ev.from.displayName).toBe(a.displayName);
    expect(ev.game.title).toBe("MARIOPARTYDS");          // client renders "<from> ti invita a giocare a <title>"
    expect((await api("GET", "/api/invites", { token: b.token })).body.incoming).toHaveLength(1);
    const acc = await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } });
    expect(acc.body.status).toBe("accepted");
    const sid = acc.body.sessionId;
    expect((await until(() => pa.events.find((e) => e.t === "invite_update"))).sessionId).toBe(sid);

    const sa = (await api("GET", `/api/sessions/${sid}`, { token: a.token })).body.session;
    const sb = (await api("GET", `/api/sessions/${sid}`, { token: b.token })).body.session;
    expect(sa).toMatchObject({ slot: 1, hasCartridge: true, platform: "nds" });
    expect(sb).toMatchObject({ slot: 2, hasCartridge: false, platform: "nds" });
    expect(sb.players.map((p: any) => p.displayName)).toEqual([a.displayName, b.displayName]);
    // both are now IN_GAME for their friends
    const c = await newAccount(); await befriend(c, a); await befriend(c, b);
    expect(await statusOf(c, a.id)).toBe("IN_GAME");
    expect(await statusOf(c, b.id)).toBe("IN_GAME");
    // the invite cannot be answered twice
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(409);
    pa.ws.close(); pb.ws.close();
  });

  it("refuse works and notifies the inviter", async () => {
    const { a, b, gameId } = await pair();
    const pa = await openPresence(a); await openPresence(b);
    const inv = await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } });
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: false } })).body.status).toBe("refused");
    expect((await until(() => pa.events.find((e) => e.t === "invite_update"))).status).toBe("refused");
    expect((await api("GET", "/api/invites", { token: b.token })).body.incoming).toHaveLength(0);
  });

  it("guards: friend offline / not friends / not your game / only the invitee answers / expiry", async () => {
    const { a, b, gameId } = await pair();
    expect((await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } })).body.error).toBe("friend_offline");
    const stranger = await newAccount();
    await openPresence(stranger);
    expect((await api("POST", "/api/invites", { token: a.token, body: { friendId: stranger.id, gameId } })).status).toBe(403);
    await openPresence(b);
    const bGame = await addGame(b, [{ name: "b.nds", data: makeNds("BGAME") }]);
    expect((await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId: bGame.body.gameId } })).status).toBe(404);   // not a's game
    const inv = await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } });
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: a.token, body: { accept: true } })).status).toBe(404);
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: stranger.token, body: { accept: true } })).status).toBe(404);
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, inv.body.id).run();
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(410);
  });

  it("a friend who is already in a game cannot be invited", async () => {
    const { a, b, gameId } = await pair();
    await openPresence(a); await openPresence(b);
    const inv = await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } });
    await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } });
    const c = await newAccount(); await befriend(c, b); await openPresence(c);
    const cg = await addGame(c, [{ name: "c.nds", data: makeNds("C") }]);
    expect((await api("POST", "/api/invites", { token: c.token, body: { friendId: b.id, gameId: cg.body.gameId } })).body.error).toBe("friend_busy");
  });

  it("inviter can cancel", async () => {
    const { a, b, gameId } = await pair();
    await openPresence(b);
    const inv = await api("POST", "/api/invites", { token: a.token, body: { friendId: b.id, gameId } });
    expect((await api("DELETE", `/api/invites/${inv.body.id}`, { token: a.token })).status).toBe(200);
    expect((await api("POST", `/api/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } })).status).toBe(409);
  });
});

describe("session: authorisation and content", () => {
  async function started() {
    const ctx = await pair();
    await openPresence(ctx.a); await openPresence(ctx.b);
    const inv = await api("POST", "/api/invites", { token: ctx.a.token, body: { friendId: ctx.b.id, gameId: ctx.gameId } });
    const sid = (await api("POST", `/api/invites/${inv.body.id}/respond`, { token: ctx.b.token, body: { accept: true } })).body.sessionId as string;
    return { ...ctx, sid, stub: env.SESSION.get(env.SESSION.idFromString(sid)) };
  }

  it("only the two players can see the session; strangers get 404", async () => {
    const { sid } = await started();
    const x = await newAccount();
    expect((await api("GET", `/api/sessions/${sid}`, { token: x.token })).status).toBe(404);
    expect((await api("POST", `/api/sessions/${sid}/heartbeat`, { token: x.token })).status).toBe(404);
    expect((await api("POST", `/api/sessions/${sid}/end`, { token: x.token })).status).toBe(404);
    expect((await api("GET", `/api/sessions/not-a-session`, { token: x.token })).status).toBe(404);
  });

  it("Player 2 never receives Player 1's ROM: the manifest hands the container the HOST's files, guest-side routes serve nothing", async () => {
    const { a, b, rom, sid, stub } = await started();
    const man = await stub.manifest();
    expect(man!.slots[0]).toMatchObject({ slot: 1, hasContent: true });
    expect(man!.slots[1]).toMatchObject({ slot: 2, hasContent: false });
    expect(man!.files).toHaveLength(1);
    // the browsers' own responses never contain file ids, keys, or ROM bytes
    for (const acc of [a, b]) {
      const r = await api("GET", `/api/sessions/${sid}`, { token: acc.token });
      expect(JSON.stringify(r.body)).not.toContain(man!.files[0].id);
      expect(JSON.stringify(r.body)).not.toMatch(/ticket|token|r2|u\//i);
    }
    // a logged-in guest cannot reach the internal route (needs the shared secret AND the ticket)
    const g = await api("GET", `/internal/sessions/${sid}/files/${man!.files[0].id}`, { token: b.token, headers: { "x-dslink-ticket": "guess" } });
    expect(g.status).toBe(401);
    expect(rom.length).toBeGreaterThan(0);
  });

  it("the container fetches the ROM with a ticket - once per file - and a wrong or expired ticket gets nothing", async () => {
    const { rom, sid, stub } = await started();
    const man = (await stub.manifest())!;
    const ticket = await runInDurableObject(stub, async (inst: any) => inst.issueTicket());
    const url = `/internal/sessions/${sid}/files/${man.files[0].id}`;
    expect((await api("GET", url, { headers: internalHdr("wrong-ticket") })).status).toBe(403);
    const ok = await api("GET", url, { headers: internalHdr(ticket) });
    expect(ok.status).toBe(200);
    expect(ok.bytes).toEqual(rom);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await api("GET", url, { headers: internalHdr(ticket) })).status).toBe(403);               // one-time per file
    const t2 = await runInDurableObject(stub, async (inst: any) => inst.issueTicket());
    await runInDurableObject(stub, async (_i, state) => { const t = (await state.storage.get<any>("tickets")); for (const k of Object.keys(t)) t[k].exp = Date.now() - 1; await state.storage.put("tickets", t); });
    expect((await api("GET", url, { headers: internalHdr(t2) })).status).toBe(403);                    // expired
  });

  it("each slot gets ITS OWN firmware; a slot cannot pull the other player's", async () => {
    const { a, b, sid, stub } = await started();
    const fwA = new Uint8Array(262144).fill(0xa1), fwB = new Uint8Array(131072).fill(0xb2);
    await api("PUT", "/api/library/system/nds/firmware.bin", { token: a.token, raw: fwA, headers: { "content-length": String(fwA.length) } });
    await api("PUT", "/api/library/system/nds/firmware.bin", { token: b.token, raw: fwB, headers: { "content-length": String(fwB.length) } });
    const ticket = await runInDurableObject(stub, async (inst: any) => inst.issueTicket());
    const s1 = await api("GET", `/internal/sessions/${sid}/slot/1/system/firmware.bin`, { headers: internalHdr(ticket) });
    const s2 = await api("GET", `/internal/sessions/${sid}/slot/2/system/firmware.bin`, { headers: internalHdr(ticket) });
    expect(s1.bytes).toEqual(fwA);
    expect(s2.bytes).toEqual(fwB);
    expect(s2.bytes.length).not.toBe(s1.bytes.length);
    const man = (await stub.manifest())!;
    expect(man.slots[0].system).toEqual(["firmware.bin"]);
    expect(man.slots[1].system).toEqual(["firmware.bin"]);
  });

  it("the container uploads the host's save at the end; the host can export it", async () => {
    const { a, gameId, sid, stub } = await started();
    const ticket = await runInDurableObject(stub, async (inst: any) => inst.issueTicket());
    const sav = new Uint8Array(1024).map((_, i) => (i * 7) & 255);
    const up = await api("PUT", `/internal/sessions/${sid}/save/sram`, { headers: { ...internalHdr(ticket), "content-length": "1024" }, raw: sav });
    expect(up.status).toBe(200);
    const dl = await api("GET", `/api/library/games/${gameId}/save/sram`, { token: a.token });
    expect(dl.bytes).toEqual(sav);
  });

  it("heartbeats keep it alive; idle sessions end, release both players and are recorded in the history", async () => {
    const { a, b, sid, stub } = await started();
    expect((await api("POST", `/api/sessions/${sid}/heartbeat`, { token: a.token })).body.ok).toBe(true);
    await runDurableObjectAlarm(stub);
    expect((await api("GET", `/api/sessions/${sid}`, { token: a.token })).body.session.status).toBe("running");
    // nobody heartbeats for longer than the idle window
    await runInDurableObject(stub, async (_i, state) => { const s = await state.storage.get<any>("s"); s.seen = { x: Date.now() - 10 * 60_000 }; await state.storage.put("s", s); });
    await runDurableObjectAlarm(stub);
    expect((await api("GET", `/api/sessions/${sid}`, { token: a.token })).body.session.status).toBe("ended");
    const watcher = await newAccount(); await befriend(watcher, a); await befriend(watcher, b);
    expect(await statusOf(watcher, a.id)).not.toBe("IN_GAME");
    expect(await statusOf(watcher, b.id)).not.toBe("IN_GAME");
    const h = await api("GET", "/api/history", { token: b.token });
    expect(h.body.history[0]).toMatchObject({ id: sid, status: "ended", role: "guest", game: "MARIOPARTYDS" });
    // tickets are gone: the container can no longer read anything
    expect(await runInDurableObject(stub, async (_i, state) => state.storage.get("tickets"))).toBeUndefined();
  });

  it("a session nobody ever opens is ended; either player can end it explicitly", async () => {
    const { a, sid, stub } = await started();
    await runInDurableObject(stub, async (_i, state) => { const s = await state.storage.get<any>("s"); s.createdAt = Date.now() - 10 * 60_000; await state.storage.put("s", s); });
    await runDurableObjectAlarm(stub);
    expect((await api("GET", `/api/sessions/${sid}`, { token: a.token })).body.session.status).toBe("ended");
    const s2 = await started();
    expect((await api("POST", `/api/sessions/${s2.sid}/end`, { token: s2.b.token })).body.ok).toBe(true);
    expect((await api("GET", `/api/sessions/${s2.sid}`, { token: s2.a.token })).body.session.status).toBe("ended");
  });

  it("deleting an account mid-session ends the session", async () => {
    const { a, b, sid } = await started();
    await api("DELETE", "/api/account", { token: a.token, body: { confirm: a.username } });
    expect((await api("GET", `/api/sessions/${sid}`, { token: b.token })).body.session.status).toBe("ended");
  });

  it("the signalling socket needs a running container (not available in miniflare) and membership", async () => {
    const { a, sid } = await started();
    const x = await newAccount();
    const { exports } = await import("cloudflare:workers");
    const call = (acc: Account) => exports.default.fetch(new Request(`https://dslink.test/api/sessions/${sid}/signal`, { headers: { upgrade: "websocket", authorization: `Bearer ${acc.token}` } }));
    expect((await call(x)).status).toBe(404);
    expect((await call(a)).status).toBe(503);
  });
});
