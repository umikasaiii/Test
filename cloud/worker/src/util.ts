export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const now = () => Date.now();

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomId = (n = 16) => b64url(randomBytes(n));
export const randomToken = () => randomId(32);

export async function sha256hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "body_too_large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "body_too_large");
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, "invalid_json"); }
}

export const str = (v: unknown, name: string, min = 1, max = 200): string => {
  if (typeof v !== "string" || v.length < min || v.length > max) throw new HttpError(400, "invalid_" + name);
  return v;
};

/** Never put file names, keys or user content in logs. */
export const logEvent = (event: string, fields: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...fields }));
