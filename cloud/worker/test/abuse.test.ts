// FASE 9 hardening: the social endpoints that can be used to harass people or to enumerate accounts are throttled per account
// (user search, friend requests, game invites). Limits are per Worker isolate (see src/ratelimit.ts): they stop a runaway client or a script, not a distributed attack.
import { describe, expect, it } from "vitest";
import { api, befriend, newAccount, uniq } from "./helpers";

describe("abuse limits", () => {
  it("user search is throttled (enumeration), real searches keep working below the limit", async () => {
    const a = await newAccount(); const q = uniq("zz").slice(0, 6); let last = 0, first = 0;
    for (let i = 0; i < 95; i++) { last = (await api("GET", `/api/users/search?q=${q}`, { token: a.token })).status; if (i === 0) first = last; }
    expect(first).toBe(200); expect(last).toBe(429);
  });

  it("friend requests are throttled per account", async () => {
    const a = await newAccount(); let last = 0, ok = 0;
    for (let i = 0; i < 34; i++) { const r = await api("POST", "/api/friends/requests", { token: a.token, body: { username: "nobody" + i } }); last = r.status; if (r.status === 404) ok++; }
    expect(ok).toBe(30);                                 // 30 attempts were answered (user_not_found), the next ones are refused
    expect(last).toBe(429);
  });

  it("game invites are throttled per account and still need a friend who is online (no invite to strangers)", async () => {
    const a = await newAccount(), b = await newAccount(), stranger = await newAccount(); await befriend(a, b); let last = 0;
    expect((await api("POST", "/api/play/invites", { token: a.token, body: { friendId: stranger.id, gameId: "nds-abcd" } })).status).toBe(403);   // not friends
    for (let i = 0; i < 24; i++) last = (await api("POST", "/api/play/invites", { token: a.token, body: { friendId: b.id, gameId: "nds-abcd" } })).status;
    expect(last).toBe(429);
  });
});
