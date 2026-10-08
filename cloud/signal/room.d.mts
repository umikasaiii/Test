export const KINDS: Set<string>;
export const MAX_MSG: number;
export const CORS: Record<string, string>;
export function validMessage(d: unknown): boolean;
export function token(): string;
export function newCode(): string;
export function reply(status: number, body: unknown): Response;
export class Room {
  constructor(code: string, opts?: { ttlMs?: number; graceMs?: number; staleMs?: number; inviteOnly?: boolean; now?: () => number });
  state: "CREATED" | "WAITING" | "READY" | "STARTING" | "IN_GAME" | "DISCONNECTED" | "CLOSED"; inviteOnly: boolean;
  setPhase(role: "host" | "guest", phase: string): { ok: true; state: string } | { error: string; status: number };
  code: string; closed: boolean; tok: { host: string; guest: string | null };
  touch(): void; expired(): boolean; roleOf(t: string | null): "host" | "guest" | null;
  join(): { token: string } | { error: string; status: number };
  subscribe(role: "host" | "guest"): Response | null;
  send(role: "host" | "guest", data: unknown): { ok: true; delivered: boolean } | { error: string; status: number };
  leave(role: "host" | "guest", why?: string): void;
  ping(): void; close(): void;
}
