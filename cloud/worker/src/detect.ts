// Platform detection from file headers. Only structure is checked; nothing is looked up, fetched or compared to any database of games.
import type { Platform } from "./env";

export type FileRole = "rom" | "chd" | "cue" | "bin";
export interface Classified { role: FileRole; platform: Platform | null }

export function crc16(b: Uint8Array): number {
  let c = 0xffff;
  for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; }
  return c;
}

const ext = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

/** Nintendo DS cartridge header: logo CRC field 0xCF56 at 0x15C and the header CRC-16 over 0x000-0x15D stored at 0x15E. */
export function isNdsHeader(h: Uint8Array): boolean {
  if (h.length < 0x160) return false;
  const logo = h[0x15c] | (h[0x15d] << 8);
  const hcrc = h[0x15e] | (h[0x15f] << 8);
  return logo === 0xcf56 && hcrc === crc16(h.subarray(0, 0x15e));
}

export function ndsTitle(h: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 12 && h[i]; i++) s += h[i] >= 32 && h[i] < 127 ? String.fromCharCode(h[i]) : "";
  return s.trim();
}

export const isChdHeader = (h: Uint8Array) => h.length >= 8 && new TextDecoder().decode(h.subarray(0, 8)) === "MComprHD";

/** a .cue sheet is small ASCII/UTF-8 text with FILE / TRACK / INDEX directives */
export function parseCue(text: string): string[] | null {
  if (text.length > 64 * 1024 || /[\x00-\x08\x0e-\x1f]/.test(text)) return null;
  const files: string[] = [];
  let tracks = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const f = line.match(/^FILE\s+(?:"([^"]+)"|(\S+))\s+\w+$/i);
    if (f) files.push((f[1] ?? f[2]).split(/[\\/]/).pop()!);
    else if (/^TRACK\s+\d+\s+\w+/i.test(line)) tracks++;
  }
  return files.length > 0 && tracks > 0 ? files : null;
}

export function classifyByHeader(name: string, header: Uint8Array): Classified | null {
  switch (ext(name)) {
    case "nds": return isNdsHeader(header) ? { role: "rom", platform: "nds" } : null;
    case "chd": return isChdHeader(header) ? { role: "chd", platform: "ps1" } : null;
    case "cue": return { role: "cue", platform: "ps1" };       // validated in full at completion
    case "bin": return { role: "bin", platform: null };         // raw track: only valid next to its .cue
    default: return null;
  }
}

export const SIZE_LIMITS: Record<FileRole, number> = { rom: 512 * 2 ** 20, chd: 2 * 2 ** 30, cue: 64 * 1024, bin: 1024 * 2 ** 20 };
