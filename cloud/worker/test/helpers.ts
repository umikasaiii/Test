import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { crc16 } from "../src/detect";
import { b64url } from "../src/util";

export const ORIGIN = "https://dslink.test";
let counter = 0;
export const uniq = (p = "u") => `${p}${Date.now().toString(36).slice(-5)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);

export interface Res<T = any> { status: number; body: T; headers: Headers; res: Response; bytes: Uint8Array }
export async function api<T = any>(method: string, path: string, opts: { token?: string; body?: unknown; raw?: BodyInit | null; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Res<T>> {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== null) h.origin = opts.origin ?? ORIGIN;
  let body: BodyInit | null | undefined = opts.raw;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); h["content-type"] = "application/json"; }
  const res = await exports.default.fetch(new Request(ORIGIN + path, { method, headers: h, body }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, headers: res.headers, res, bytes };
}

export interface Account { token: string; id: string; username: string; displayName: string }
export async function newAccount(name = uniq()): Promise<Account> {
  const r = await api("POST", "/api/auth/register", { body: { username: name, displayName: name.toUpperCase(), password: "correct horse battery staple" } });
  if (r.status !== 201) throw new Error("register failed " + JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.userId, username: name, displayName: name.toUpperCase() };
}

export async function befriend(a: Account, b: Account) {
  const r = await api("POST", "/api/friends/requests", { token: a.token, body: { username: b.username } });
  const reqs = await api("GET", "/api/friends/requests", { token: b.token });
  const id = reqs.body.incoming.find((x: any) => x.user.userId === a.id).id;
  await api("POST", `/api/friends/requests/${id}/accept`, { token: b.token });
  return r;
}

/** a syntactically valid NDS header (title, logo field 0xCF56, header CRC) + payload */
export function makeNds(title = "DSLINKTEST1", size = 4096, fill = 0x5a): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size).fill(fill);
  b.fill(0, 0, 0x200);
  for (let i = 0; i < title.length; i++) b[i] = title.charCodeAt(i);
  b[0x15c] = 0x56; b[0x15d] = 0xcf;
  const c = crc16(b.subarray(0, 0x15e));
  b[0x15e] = c & 255; b[0x15f] = c >> 8;
  return b;
}

export const hdr = (b: Uint8Array) => b64url(b.slice(0, 1024));

export async function addGame(acc: Account, files: { name: string; data: Uint8Array<ArrayBuffer> }[]) {
  const c = await api("POST", "/api/library/games", { token: acc.token, body: { files: files.map((f) => ({ name: f.name, size: f.data.length, header: hdr(f.data) })) } });
  if (c.status !== 201) return c;
  for (const u of c.body.uploads) {
    const f = files.find((x) => x.name === u.name)!;
    const p = await api("PUT", u.url, { token: acc.token, raw: f.data, headers: { "content-length": String(f.data.length) } });
    if (p.status !== 200) return p;
  }
  return api("POST", `/api/library/games/${c.body.gameId}/complete`, { token: acc.token });
}

export async function openPresence(acc: Account) {
  const res = await exports.default.fetch(new Request(ORIGIN + "/api/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${acc.token}`, origin: ORIGIN } }));
  const ws = res.webSocket!;
  ws.accept();
  const events: any[] = [];
  ws.addEventListener("message", (e) => { events.push(JSON.parse(e.data as string)); });
  return { ws, events, status: res.status };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(30); }
}
export { env };
