import { afterEach, describe, expect, it, vi } from "vitest";
import { browserIce, mintIceServers } from "../src/turn";
import type { Env } from "../src/env";

const base = { ICE_SERVERS: undefined } as unknown as Env;
afterEach(() => vi.restoreAllMocks());

describe("TURN credentials (Cloudflare Realtime)", () => {
  it("returns null and falls back to public STUN when no TURN key is configured", async () => {
    expect(await mintIceServers(base, 3600)).toBeNull();
    expect(await browserIce(base)).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });
  it("mints short-lived credentials with the secret in the Authorization header only, ttl clamped to 48h", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }] }), { status: 201 }));
    const env = { ...base, TURN_KEY_ID: "kid", TURN_KEY_API_TOKEN: "secret" } as Env;
    const ice = await mintIceServers(env, 10 * 24 * 3600);
    expect(ice?.[0].username).toBe("u");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 48 * 3600 });
    expect(url).not.toContain("secret");
  });
  it("never throws: an API failure degrades to the static / STUN servers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const env = { ...base, TURN_KEY_ID: "kid", TURN_KEY_API_TOKEN: "secret", ICE_SERVERS: JSON.stringify([{ urls: "stun:example:3478" }]) } as Env;
    expect(await mintIceServers(env, 60)).toBeNull();
    expect(await browserIce(env)).toEqual([{ urls: "stun:example:3478" }]);
  });
});
