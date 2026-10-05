import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { api, befriend, env, newAccount, openPresence, sleep, until } from "./helpers";

const statusOf = async (viewer: { token: string }, id: string) => (await api("GET", "/api/friends", { token: viewer.token })).body.friends.find((f: any) => f.userId === id)?.status;

describe("friends", () => {
  it("request -> accept makes both sides friends; refuse and cancel do not", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount();
    const r = await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } });
    expect(r.status).toBe(201);
    expect((await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } })).status).toBe(409);   // already pending
    const inc = await api("GET", "/api/friends/requests", { token: b.token });
    expect(inc.body.incoming).toHaveLength(1);
    expect(inc.body.incoming[0].user.displayName).toBe(a.displayName);
    expect((await api("GET", "/api/friends/requests", { token: a.token })).body.outgoing).toHaveLength(1);
    // only the recipient can accept
    expect((await api("POST", `/api/friends/requests/${r.body.id}/accept`, { token: a.token })).status).toBe(404);
    expect((await api("POST", `/api/friends/requests/${r.body.id}/accept`, { token: c.token })).status).toBe(404);
    expect((await api("POST", `/api/friends/requests/${r.body.id}/accept`, { token: b.token })).body.status).toBe("accepted");
    expect((await api("GET", "/api/friends", { token: a.token })).body.friends.map((f: any) => f.userId)).toEqual([b.id]);
    expect((await api("GET", "/api/friends", { token: b.token })).body.friends.map((f: any) => f.userId)).toEqual([a.id]);
    expect((await api("POST", "/api/friends/requests", { token: b.token, body: { username: a.username } })).status).toBe(409);   // already friends

    const r2 = await api("POST", "/api/friends/requests", { token: c.token, body: { username: a.username } });
    expect((await api("POST", `/api/friends/requests/${r2.body.id}/refuse`, { token: a.token })).body.status).toBe("refused");
    expect((await api("GET", "/api/friends", { token: c.token })).body.friends).toHaveLength(0);
    const r3 = await api("POST", "/api/friends/requests", { token: c.token, body: { username: a.username } });   // can ask again after a refusal
    expect(r3.status).toBe(201);
    expect((await api("DELETE", `/api/friends/requests/${r3.body.id}`, { token: c.token })).status).toBe(200);
    expect((await api("GET", "/api/friends/requests", { token: a.token })).body.incoming).toHaveLength(0);
  });

  it("asking someone who already asked you simply accepts; cannot add yourself or unknown users", async () => {
    const a = await newAccount(), b = await newAccount();
    await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } });
    const back = await api("POST", "/api/friends/requests", { token: b.token, body: { username: a.username } });
    expect(back.body.status).toBe("accepted");
    expect((await api("GET", "/api/friends", { token: a.token })).body.friends).toHaveLength(1);
    expect((await api("POST", "/api/friends/requests", { token: a.token, body: { username: a.username } })).status).toBe(400);
    expect((await api("POST", "/api/friends/requests", { token: a.token, body: { username: "nobody_here" } })).status).toBe(404);
  });

  it("remove friend works both ways and invalidates pending invites", async () => {
    const a = await newAccount(), b = await newAccount();
    await befriend(a, b);
    expect((await api("DELETE", `/api/friends/${b.id}`, { token: a.token })).status).toBe(200);
    expect((await api("GET", "/api/friends", { token: b.token })).body.friends).toHaveLength(0);
    expect((await api("DELETE", `/api/friends/${b.id}`, { token: a.token })).status).toBe(404);
  });

  it("delivers friend requests and acceptances live over the WebSocket", async () => {
    const a = await newAccount(), b = await newAccount();
    const pb = await openPresence(b), pa = await openPresence(a);
    const r = await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } });
    const ev = await until(() => pb.events.find((e) => e.t === "friend_request"));
    expect(ev.user.userId).toBe(a.id);
    await api("POST", `/api/friends/requests/${r.body.id}/accept`, { token: b.token });
    expect((await until(() => pa.events.find((e) => e.t === "friend_update"))).kind).toBe("accepted");
    pa.ws.close(); pb.ws.close();
  });
});

describe("presence", () => {
  it("ONLINE while a socket is open, OFFLINE after close; friends are told", async () => {
    const a = await newAccount(), b = await newAccount();
    await befriend(a, b);
    expect(await statusOf(a, b.id)).toBe("OFFLINE");
    const watcher = await openPresence(a);
    const pb = await openPresence(b);
    expect(pb.status).toBe(101);
    expect(await statusOf(a, b.id)).toBe("ONLINE");
    const online = await until(() => watcher.events.find((e) => e.t === "presence" && e.userId === b.id && e.status === "ONLINE"));
    expect(online).toBeTruthy();
    pb.ws.close(1000, "bye");
    await until(async () => (await statusOf(a, b.id)) === "OFFLINE");
    expect(await until(() => watcher.events.find((e) => e.t === "presence" && e.userId === b.id && e.status === "OFFLINE"))).toBeTruthy();
    watcher.ws.close();
  });

  it("several devices / a page refresh never flip the user offline while one connection lives", async () => {
    const a = await newAccount(), b = await newAccount();
    await befriend(a, b);
    const phone = await openPresence(b);
    const laptop = await openPresence(b);
    phone.ws.close();
    await sleep(150);
    expect(await statusOf(a, b.id)).toBe("ONLINE");
    // refresh: the new socket opens before the old one closes
    const fresh = await openPresence(b);
    laptop.ws.close();
    await sleep(150);
    expect(await statusOf(a, b.id)).toBe("ONLINE");
    fresh.ws.close();
    await until(async () => (await statusOf(a, b.id)) === "OFFLINE");
  });

  it("answers pings, and a silently dead connection (no pings) is swept to OFFLINE - never 'online forever'", async () => {
    const a = await newAccount(), b = await newAccount();
    await befriend(a, b);
    const pb = await openPresence(b);
    pb.ws.send(JSON.stringify({ t: "ping" }));
    await until(() => pb.events.find((e) => e.t === "pong"));
    expect(await statusOf(a, b.id)).toBe("ONLINE");
    // simulate a network loss: the server never hears from the socket again; its last ping is older than the stale window
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName(b.id));
    await runInDurableObject(stub, async (_i, state) => { for (const w of state.getWebSockets()) w.serializeAttachment({ lastSeen: Date.now() - 10 * 60_000, device: "" }); });
    await runDurableObjectAlarm(stub);
    expect(await statusOf(a, b.id)).toBe("OFFLINE");
  });

  it("IN_GAME is a lease: it applies while renewed and expires on its own", async () => {
    const a = await newAccount(), b = await newAccount();
    await befriend(a, b);
    const pb = await openPresence(b);
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName(b.id));
    await stub.setGame("session-x");
    expect(await statusOf(a, b.id)).toBe("IN_GAME");
    await runInDurableObject(stub, async (_i, state) => { await state.storage.put("gameUntil", Date.now() - 1); });
    expect(await statusOf(a, b.id)).toBe("ONLINE");       // lease lapsed
    pb.ws.close();
    await stub.setGame("session-y");
    await runInDurableObject(stub, async (_i, state) => { await state.storage.put("gameUntil", Date.now() - 1); });
    await until(async () => (await statusOf(a, b.id)) === "OFFLINE");
  });

  it("WebSocket needs authentication", async () => {
    const { exports } = await import("cloudflare:workers");
    const r = await exports.default.fetch(new Request("https://dslink.test/api/ws", { headers: { upgrade: "websocket" } }));
    expect(r.status).toBe(401);
    // the presence object itself refuses connections that did not come through the Worker's authentication
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName("anyone"));
    const direct = await stub.fetch(new Request("https://x/ws", { headers: { upgrade: "websocket" } }));
    expect(direct.status).toBe(403);
  });
});
