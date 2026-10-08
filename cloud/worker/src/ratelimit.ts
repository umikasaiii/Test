// Basic per-account rate limiting (per Worker isolate): enough to stop a runaway client or a script, not a distributed attack.
import { HttpError, now } from "./util";

const hits = new Map<string, number[]>();
export function limit(userId: string, what: string, max: number, windowMs = 10 * 60_000) {
  const k = userId + ":" + what, t = now(), a = (hits.get(k) ?? []).filter((x) => t - x < windowMs);
  if (a.length >= max) { hits.set(k, a); throw new HttpError(429, "rate_limited"); }
  a.push(t); hits.set(k, a);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(kk);
}
