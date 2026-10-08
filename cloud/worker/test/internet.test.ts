import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { api, befriend, env, newAccount, openPresence, ORIGIN, sleep, until, uniq } from "./helpers";
import worker from "../src/index";

const bytesHmac = async (hash: "SHA-1" | "SHA-256", secret: string, data: string) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"]), new TextEncoder().encode(data)));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const SECRET = "test-turn-shared-secret-0123456789";
const withTurn = (extra: Record<string, string> = {}) => ({ ...env, DSLINK_TURN_URLS: "turn:turn.example.net:3478?transport=udp,turns:turn.example.net:5349?transport=tcp", DSLINK_TURN_SECRET: SECRET, ...extra }) as any;
const viaWorker = (e: any, token: string, method: string, path: string, body?: unknown) => worker.fetch(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e);

describe("Realtime ICE: server-side, short-lived, never in the PWA", () => {
  it("needs an account; with nothing configured it is STUN only and says there is no relay", async () => {
    expect((await api("GET", "/api/realtime/ice")).status).toBe(401);
    const a = await newAccount(); const r = await api("GET", "/api/realtime/ice", { token: a.token });
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.body.policy).toMatchObject({ relayAvailable: false, stunOnly: true, providers: ["stun"], iceTransportPolicy: "all" });
    expect(r.body.iceServers).toHaveLength(1); expect(JSON.stringify(r.body)).not.toMatch(/"username"|"credential"/);
    expect(r.body.iceServers[0].urls.every((u: string) => /^stun:/.test(u))).toBe(true); expect(r.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("derives a short-lived TURN credential per request from the shared secret (coturn use-auth-secret scheme) and never reveals the secret", async () => {
    const a = await newAccount(); const res = await viaWorker(withTurn(), a.token, "GET", "/api/realtime/ice"); const j: any = await res.json();
    expect(res.status).toBe(200); expect(j.policy).toMatchObject({ relayAvailable: true, stunOnly: false }); expect(j.policy.providers).toContain("turn-secret");
    const turn = j.iceServers.find((s: any) => s.username);
    expect(turn.urls).toEqual(["turn:turn.example.net:3478?transport=udp", "turns:turn.example.net:5349?transport=tcp"]);
    const [exp, tag] = turn.username.split(":"); expect(Number(exp) * 1000).toBe(j.expiresAt); expect(tag).toMatch(/^[0-9a-f]{12}$/);
    expect(turn.credential).toBe(b64(await bytesHmac("SHA-1", SECRET, turn.username)));                    // exactly what the TURN server computes
    expect(j.expiresAt - Date.now()).toBeGreaterThan(3500_000); expect(j.expiresAt - Date.now()).toBeLessThanOrEqual(3600_000 + 2000);   // 1 h default
    const text = JSON.stringify(j); expect(text).not.toContain(SECRET); expect(text).not.toContain(a.id); expect(text).not.toContain(a.username);   // no secret, no account id in the username
    const b = await newAccount(); const jb: any = await (await viaWorker(withTurn(), b.token, "GET", "/api/realtime/ice")).json();
    expect(jb.iceServers.find((s: any) => s.username).username.split(":")[1]).not.toBe(tag);                // another account, another opaque tag
  });

  it("username modes, custom TTL, and an incomplete TURN configuration is not advertised", async () => {
    const a = await newAccount();
    const j1: any = await (await viaWorker(withTurn({ DSLINK_TURN_USERNAME_MODE: "timestamp", DSLINK_TURN_TTL_SECONDS: "900" }), a.token, "GET", "/api/realtime/ice")).json();
    const t = j1.iceServers.find((s: any) => s.username); expect(t.username).toMatch(/^\d+$/); expect(j1.ttlSeconds).toBe(900); expect(j1.metadata.usernameMode).toBe("timestamp");
    for (const bad of [{ DSLINK_TURN_SECRET: "" }, { DSLINK_TURN_URLS: "https://not-a-turn-url" }]) {
      const j: any = await (await viaWorker(withTurn(bad), a.token, "GET", "/api/realtime/ice")).json();
      expect(j.policy.relayAvailable).toBe(false); expect(JSON.stringify(j)).not.toMatch(/"credential"/);
    }
    const j2: any = await (await viaWorker({ ...env, DSLINK_STUN_URLS: "stun:stun.mine.example:3478, nonsense, stun:b.example:3478" } as any, a.token, "GET", "/api/realtime/ice")).json();
    expect(j2.iceServers[0].urls).toEqual(["stun:stun.mine.example:3478", "stun:b.example:3478"]);          // configurable STUN, junk dropped
  });

  it("is rate limited per account", async () => {
    const a = await newAccount(); let last = 0;
    for (let i = 0; i < 45; i++) last = (await api("GET", "/api/realtime/ice", { token: a.token })).status;
    expect(last).toBe(429);
  });
});

describe("Game network profile (generic, data driven)", () => {
  const entry = (gameId: string, productCode: string, extra: Record<string, unknown> = {}) => ({ gameId, platform: "nds", title: "T " + gameId, productCode, coreId: "melonds-ds", multiplayerMode: "distributed", downloadPlaySupported: false, ...extra });
  it("comes from the profile table, the Download Play capability or an admin pin - never from what a client claims", async () => {
    const a = await newAccount();
    await api("POST", "/api/cloud/library/sync", { token: a.token, body: { entries: [entry("nds-ampe", "AMPE"), entry("nds-ampp", "AMPP", { networkProfile: "NORMAL" }), entry("nds-dltt", "DLTT"), entry("nds-zzzz", "ZZZZ"), entry("nds-zdlp", "ZDLP", { downloadPlaySupported: true }), entry("nds-pinn", "PINN")] } });
    const prof = async () => Object.fromEntries((await api("GET", "/api/cloud/library", { token: a.token })).body.entries.map((e: any) => [e.gameId, e.networkProfile]));
    expect(await prof()).toMatchObject({ "nds-ampe": "LOW_LATENCY_REQUIRED", "nds-ampp": "LOW_LATENCY_REQUIRED", "nds-dltt": "NORMAL", "nds-zzzz": "UNKNOWN", "nds-zdlp": "LOW_LATENCY_REQUIRED" });   // the client-sent "NORMAL" for Mario is ignored
    await env.DB.prepare("UPDATE game_metadata SET network_profile = 'NORMAL' WHERE game_id = 'nds-pinn'").run();
    expect((await prof())["nds-pinn"]).toBe("NORMAL");
    expect((await api("GET", "/api/catalog", { token: a.token })).body.games.find((g: any) => g.gameId === "nds-ampe").networkProfile).toBe("LOW_LATENCY_REQUIRED");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------ Party
const online = async (acc: { token: string }) => { const p = await openPresence(acc as any); await until(() => p.events.length > 0); return p; };
async function partyOf(a: { token: string }) { return (await api("GET", "/api/party/me", { token: a.token })).body.party; }
async function joined(owner: any, other: any) {
  const o = await online(other); const inv = await api("POST", "/api/party/invites", { token: owner.token, body: { userId: other.id } });
  const r = await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: other.token, body: { accept: true } }); return { o, inv, r };
}
async function party(acc: any) { const res = await exports.default.fetch(new Request(ORIGIN + "/api/party/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${acc.token}`, origin: ORIGIN } })); const ws = res.webSocket; if (!ws) return { status: res.status, ws: null as any, ev: [] as any[], closed: null as any }; ws.accept(); const ev: any[] = []; const st: any = { status: res.status, ws, ev, closed: null }; ws.addEventListener("message", (e) => ev.push(JSON.parse(e.data as string))); ws.addEventListener("close", (e) => { st.closed = e.code; }); return st; }

describe("Party: membership, invites, owner, kick, blocks", () => {
  it("creates a party, one at a time, and invites only online friends who are not blocked", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount();
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).body.error).toBe("not_in_party");
    const p = await api("POST", "/api/party", { token: a.token }); expect(p.status).toBe(201);
    expect(p.body.party).toMatchObject({ owner: a.id, max: 8 }); expect(p.body.party.members).toEqual([expect.objectContaining({ userId: a.id, role: "owner" })]); expect(p.body.party.id.length).toBeGreaterThan(12);
    expect((await api("POST", "/api/party", { token: a.token })).body.error).toBe("already_in_party");
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).body.error).toBe("not_friends");
    await befriend(a, b);
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).body.error).toBe("friend_offline");      // nobody to ring
    const pb = await online(b);
    const inv = await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } }); expect(inv.status).toBe(201);
    const ev = await until(() => pb.events.find((e) => e.t === "party_invite")); expect(ev.from.userId).toBe(a.id); expect(JSON.stringify(ev)).not.toContain(p.body.party.id);   // the party id is not leaked in the notification
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).body.error).toBe("invite_already_pending");
    expect((await api("GET", "/api/party/invites", { token: b.token })).body.incoming).toHaveLength(1);
    // someone else cannot answer it, a refusal ends it
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: c.token, body: { accept: true } })).status).toBe(404);
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: false } })).body.status).toBe("refused");
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: b.token, body: { accept: true } })).body.error).toBe("invite_not_pending");
    expect(await partyOf(b)).toBeNull();
    pb.ws.close();
  });

  it("accept joins (NEL PARTY on presence for friends), full parties and parties of others are refused, expired invites end", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount(); await befriend(a, b); await befriend(a, c); await befriend(b, c);
    await api("POST", "/api/party", { token: a.token }); const { r } = await joined(a, b);
    expect(r.body.status).toBe("accepted"); expect(r.body.party.members.map((m: any) => m.userId)).toEqual([a.id, b.id]);
    const fl = await api("GET", "/api/friends", { token: c.token });
    expect(fl.body.friends.find((f: any) => f.userId === a.id).party).toBe(true); expect(fl.body.friends.find((f: any) => f.userId === b.id).party).toBe(true);
    expect(JSON.stringify(fl.body)).not.toContain((await partyOf(a)).id);                                    // friends see THAT someone is in a party, never which one
    await online(c); await api("POST", "/api/party", { token: c.token });
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: c.id } })).body.error).toBe("friend_in_party");
    // full: fill the party up to 8 with rows, then the 9th cannot be invited, nor accept an older invite
    const d = await newAccount(); await befriend(a, d); await online(d); await api("POST", "/api/party/leave", { token: c.token });
    const pid = (await partyOf(a)).id; const inv = await api("POST", "/api/party/invites", { token: a.token, body: { userId: d.id } });
    for (let i = 0; i < 6; i++) { const x = await newAccount(); await env.DB.prepare("INSERT INTO party_members (party_id, user_id, joined_at) VALUES (?,?,?)").bind(pid, x.id, Date.now() + i).run(); }
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: d.token, body: { accept: true } })).body.error).toBe("party_full");
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: c.id } })).body.error).toBe("party_full");
    await env.DB.prepare("UPDATE party_invites SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, inv.body.id).run();
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: d.token, body: { accept: true } })).status).toBe(410);
  });

  it("a blocked user can neither invite nor be invited, and leaves a shared party; unfriending ends pending invites", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount(); await befriend(a, b); await befriend(a, c);
    await api("POST", "/api/party", { token: a.token }); await joined(a, b);
    const pc = await online(c); const inv = await api("POST", "/api/party/invites", { token: a.token, body: { userId: c.id } });
    expect((await api("DELETE", `/api/friends/${a.id}`, { token: c.token })).status).toBe(200);              // c unfriends a: the pending party invite ends
    expect((await api("GET", "/api/party/invites", { token: c.token })).body.incoming).toHaveLength(0);
    expect((await api("POST", `/api/party/invites/${inv.body.id}/respond`, { token: c.token, body: { accept: true } })).body.error).toBe("invite_not_pending");
    const pb = await online(b);
    await api("POST", "/api/blocks", { token: a.token, body: { username: b.username } });                      // the owner blocks a member: the member leaves
    await until(async () => (await partyOf(b)) === null);
    expect((await partyOf(a)).members).toHaveLength(1);
    expect(pb.events.some((e) => e.t === "party_kicked" && e.reason === "blocked")).toBe(true);
    expect((await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).status).toBeGreaterThanOrEqual(403);      // blocked: nobody invites
    await api("POST", "/api/party", { token: b.token }); expect((await api("POST", "/api/party/invites", { token: b.token, body: { userId: a.id } })).status).toBeGreaterThanOrEqual(403);
    pc.ws.close();
  });

  it("the owner can kick; leaving hands the party to the longest-standing member; an empty party disappears; rate limits", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount(); await befriend(a, b); await befriend(a, c);
    await api("POST", "/api/party", { token: a.token }); const jb = await joined(a, b); const jc = await joined(a, c);
    expect((await api("POST", "/api/party/kick", { token: b.token, body: { userId: c.id } })).body.error).toBe("owner_only");
    expect((await api("POST", "/api/party/kick", { token: a.token, body: { userId: a.id } })).status).toBe(400);
    const outsider = await newAccount(); expect((await api("POST", "/api/party/kick", { token: a.token, body: { userId: outsider.id } })).body.error).toBe("not_a_member");
    expect((await api("POST", "/api/party/kick", { token: a.token, body: { userId: c.id } })).status).toBe(200);
    expect(await partyOf(c)).toBeNull(); expect(jc.o.events.some((e: any) => e.t === "party_kicked" && e.reason === "kicked")).toBe(true);
    expect((await api("POST", "/api/party/leave", { token: a.token })).status).toBe(200);                       // owner leaves
    const pb = await partyOf(b); expect(pb.owner).toBe(b.id); expect(pb.members).toHaveLength(1);
    expect((await api("POST", "/api/party/leave", { token: b.token })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE id = ?").bind(pb.id).first<{ n: number }>())!.n).toBe(0);
    expect((await api("POST", "/api/party/leave", { token: b.token })).status).toBe(404);
    expect((await api("GET", "/api/friends", { token: c.token })).body.friends.every((f: any) => f.party === false)).toBe(true);
    void jb; let last = 0; await api("POST", "/api/party", { token: a.token });
    for (let i = 0; i < 24; i++) last = (await api("POST", "/api/party/invites", { token: a.token, body: { userId: b.id } })).status;
    expect(last).toBe(429);
  });
});

describe("Party signaling socket", () => {
  it("only members connect; members exchange WebRTC signaling and mic state; nothing reaches non-members; kick closes the socket", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount(); await befriend(a, b);
    expect((await party(a)).status).toBe(403);                                                                  // no party yet
    await api("POST", "/api/party", { token: a.token }); await joined(a, b);
    expect((await party(c)).status).toBe(403);                                                                  // not a member
    const A = await party(a), B = await party(b);
    await until(() => A.ev.find((e) => e.t === "peer_joined" && e.userId === b.id));
    const roster = await until(() => B.ev.find((e) => e.t === "roster")); expect(roster).toMatchObject({ you: b.id }); expect(roster.members.map((m: any) => m.userId).sort()).toEqual([a.id, b.id].sort());
    A.ws.send(JSON.stringify({ t: "signal", to: b.id, data: { k: "offer", sdp: "v=0..." } }));
    const sig = await until(() => B.ev.find((e) => e.t === "signal")); expect(sig).toMatchObject({ from: a.id, data: { k: "offer" } });
    A.ws.send(JSON.stringify({ t: "signal", to: c.id, data: { k: "offer" } })); await sleep(150);                // c is not a member: dropped
    B.ws.send(JSON.stringify({ t: "state", muted: true })); const st = await until(() => A.ev.find((e) => e.t === "state")); expect(st).toMatchObject({ userId: b.id, muted: true });
    A.ws.send(JSON.stringify({ t: "signal", to: b.id, data: { big: "x".repeat(20000) } })); await sleep(150);       // oversized: ignored
    expect(B.ev.filter((e) => e.t === "signal")).toHaveLength(1);
    A.ws.send(JSON.stringify({ t: "ping" })); await until(() => A.ev.find((e) => e.t === "pong"));
    await api("POST", "/api/party/kick", { token: a.token, body: { userId: b.id } });
    await until(() => B.closed === 4003); await until(() => A.ev.find((e) => e.t === "peer_left" && e.userId === b.id));
    expect((await party(b)).status).toBe(403);                                                                  // kicked: no more access
    A.ws.close();
  });
  it("a newer connection of the same member replaces the older one (one voice peer per member)", async () => {
    const a = await newAccount(); await api("POST", "/api/party", { token: a.token });
    const A1 = await party(a); await until(() => A1.ev.length > 0); const A2 = await party(a);
    await until(() => A1.closed === 4004); expect(A2.status).toBe(101); A2.ws.close();
  });
});
