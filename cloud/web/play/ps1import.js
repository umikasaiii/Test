// Importing PlayStation games: the user picks files (cue + bin, chd, iso, m3u, several discs...), PlaySphere groups them into GAMES (one profile per game, never one per file),
// asks the PlayStation core what each disc really is, and copies the files into the device storage by streaming (no disc image is ever loaded whole into memory).
export const PS1_EXTS = ["cue", "bin", "chd", "iso", "img", "m3u"];
export const PS1_ACCEPT = ".cue,.bin,.chd,.iso,.img,.m3u";
export const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n) || [, ""])[1].toLowerCase();
export const stemOf = (n) => n.replace(/\.[^.]+$/, "");
const DISC_RE = /[\s_-]*[(\[]?\s*(?:disc|disk|cd)\s*(\d+)\s*(?:of\s*\d+)?[)\]]?/i;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** FILE names a .cue sheet refers to (directories dropped: the files were picked flat) */
export function cueFiles(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) { const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\w+/i.exec(line); if (m) out.push((m[1] || m[2]).split(/[\\/]/).pop()); }
  return out;
}
const m3uEntries = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/[\\/]/).pop());
/** a lone .bin gets a generated sheet: raw 2352 byte sectors if the size fits, else cooked 2048 */
export function cueForBin(binName, size) { const mode = size % 2352 === 0 ? "MODE2/2352" : "MODE1/2048"; return `FILE "${binName}" BINARY\r\n  TRACK 01 ${mode}\r\n    INDEX 01 00:00:00\r\n`; }

/**
 * @param {File[]} picked
 * @returns {Promise<{games:{title:string, discs:{label:string, main:string, files:File[], generated?:{name:string,text:string}}[], format:string, m3u?:string}[], errors:string[]}>}
 */
export async function groupFiles(picked) {
  const files = picked.filter((f) => PS1_EXTS.includes(extOf(f.name)));
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f])), used = new Set(), errors = [], discs = [];
  const need = (name, owner) => { const f = byName.get(name.toLowerCase()); if (!f) { errors.push(`Manca il file «${name}» (serve a «${owner}»).`); return null; } used.add(f.name); return f; };
  // m3u first: it lists the discs of one game explicitly
  const lists = [];
  for (const f of files.filter((x) => extOf(x.name) === "m3u")) { used.add(f.name); lists.push({ f, names: m3uEntries(await f.text()) }); }
  const disc = (mainFile) => {
    const ext = extOf(mainFile.name);
    if (ext === "cue") return (async () => {
      const names = cueFiles(await mainFile.text()); if (!names.length) { errors.push(`«${mainFile.name}» non è un file .cue valido.`); return null; }
      const fs = [mainFile]; for (const n of names) { const b = need(n, mainFile.name); if (!b) return null; fs.push(b); }
      used.add(mainFile.name); return { label: stemOf(mainFile.name), main: mainFile.name, files: fs };
    })();
    used.add(mainFile.name); return Promise.resolve({ label: stemOf(mainFile.name), main: mainFile.name, files: [mainFile] });
  };
  const games = [];
  for (const L of lists) {
    const ds = []; for (const n of L.names) { const mf = need(n, L.f.name); if (!mf) { ds.length = 0; break; } const d = await disc(mf); if (!d) { ds.length = 0; break; } ds.push(d); }
    if (ds.length) games.push({ title: stemOf(L.f.name), discs: ds, format: extOf(ds[0].main), m3u: L.f.name });
  }
  const rest = files.filter((f) => !used.has(f.name));
  for (const f of rest.filter((x) => extOf(x.name) === "cue").sort((a, b) => natural(a.name, b.name))) { if (used.has(f.name)) continue; const d = await disc(f); if (d) discs.push(d); }
  for (const f of rest.filter((x) => ["chd", "iso", "img"].includes(extOf(x.name))).sort((a, b) => natural(a.name, b.name))) { if (used.has(f.name)) continue; const d = await disc(f); if (d) discs.push(d); }
  for (const f of rest.filter((x) => extOf(x.name) === "bin")) {                                        // a bin nobody refers to: single track image
    if (used.has(f.name)) continue; used.add(f.name);
    const g = { name: stemOf(f.name) + ".cue", text: cueForBin(f.name, f.size) }; discs.push({ label: stemOf(f.name), main: g.name, files: [f], generated: g });
  }
  // loose discs that differ only by "(Disc N)" are the discs of one game
  const groups = new Map();
  for (const d of discs) { const key = d.label.replace(DISC_RE, "").trim().toLowerCase() || d.label.toLowerCase(); (groups.get(key) || groups.set(key, []).get(key)).push(d); }
  for (const ds of groups.values()) {
    ds.sort((a, b) => natural(a.main, b.main));
    const multi = ds.length > 1 && ds.every((d) => DISC_RE.test(d.label));
    if (multi) games.push({ title: ds[0].label.replace(DISC_RE, "").replace(/[\s_-]+$/g, "").trim() || ds[0].label, discs: ds, format: extOf(ds[0].main) });
    else for (const d of ds) games.push({ title: d.label, discs: [d], format: extOf(d.main) });
  }
  for (const g of games) g.discs.forEach((d, i) => { if (g.discs.length > 1) d.label = `Disco ${i + 1}`; });
  if (!games.length && !errors.length) errors.push("Non ho trovato giochi PlayStation in questi file (servono .cue + .bin, .chd, .iso o .m3u).");
  return { games, errors };
}

/** Content id of a game: the sizes and names of its files plus the first and last 64 KiB of the first disc (cheap on a 700 MB image: slices are lazy) */
export async function contentId(game, sha256Hex) {
  const enc = new TextEncoder(), parts = [];
  for (const d of game.discs) for (const f of d.files) parts.push(enc.encode(`${f.name}:${f.size};`));
  const first = game.discs[0].files[game.discs[0].files.length - 1];                                    // the data file of the first disc
  const N = 65536;
  parts.push(new Uint8Array(await first.slice(0, Math.min(N, first.size)).arrayBuffer())); if (first.size > N) parts.push(new Uint8Array(await first.slice(Math.max(N, first.size - N)).arrayBuffer()));
  const len = parts.reduce((n, p) => n + p.length, 0), all = new Uint8Array(len); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return (await sha256Hex(all.buffer)).slice(0, 24);
}

export const IMPORT_ERR = {
  not_iso9660: "Questo file non è un'immagine disco valida.", not_playstation: "Questo disco non è un disco PlayStation.", playstation2: "Questo è un disco PlayStation 2: PlaySphere supporta la PlayStation originale.",
  no_boot_file: "Non trovo il programma di avvio del disco.", bin_missing: "Manca il file .bin indicato dal .cue.", cue_syntax: "Il file .cue non è valido.", audio_only: "Questo disco contiene solo audio.",
  unsupported_format: "Formato non supportato (usa .cue+.bin, .chd, .iso o .m3u).", unreadable: "Non riesco a leggere il disco.", chd_open: "Il file .chd non si apre (potrebbe essere danneggiato).", unknown_layout: "Il file non ha un layout di disco riconosciuto.",
  no_track_metadata: "Il file .chd non descrive un disco CD.", probe_failed: "Non riesco a leggere questo disco.", open: "Non riesco ad aprire il file.",
};
