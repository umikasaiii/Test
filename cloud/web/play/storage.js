// DSLink PWA storage: everything the user imports (ROMs, BIOS, firmware) and every save lives ONLY in this browser.
// Preferred backend: OPFS (Origin Private File System). Fallback: IndexedDB (Safari/iOS before OPFS writable streams, private windows, old browsers).
// Logical paths:  system/bios7.bin  system/bios9.bin  system/firmware.bin  library/<rom-id>/rom.nds  library/<rom-id>/meta.json  library/<rom-id>/save
// Nothing here ever touches the network, and no function logs file contents.

const DB = "dslink-files", STORE = "files";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "path" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const idbReq = (db, mode, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(STORE, mode); const out = fn(tx.objectStore(STORE));
  tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
});

async function idbBackend() {
  const db = await idbOpen();
  return {
    kind: "idb",
    async get(path) { const row = await idbReq(db, "readonly", (s) => s.get(path)); return row ? row.data : null; },
    async put(path, data) { await idbReq(db, "readwrite", (s) => s.put({ path, data, size: data.byteLength, t: Date.now() })); },
    async del(path) { await idbReq(db, "readwrite", (s) => s.delete(path)); },
    async list(prefix) { const keys = await idbReq(db, "readonly", (s) => s.getAllKeys()); return keys.filter((k) => k.startsWith(prefix)); },
  };
}

async function opfsBackend() {
  const root = await navigator.storage.getDirectory();
  const dirOf = async (parts, create) => { let d = root; for (const p of parts) d = await d.getDirectoryHandle(p, { create }); return d; };
  const split = (path) => { const a = path.split("/"); return [a.slice(0, -1), a[a.length - 1]]; };
  const be = {
    kind: "opfs",
    async get(path) {
      try { const [dirs, name] = split(path); const d = await dirOf(dirs, false); const f = await (await d.getFileHandle(name)).getFile(); return await f.arrayBuffer(); }
      catch (e) { if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null; throw e; }
    },
    async put(path, data) {
      const [dirs, name] = split(path); const d = await dirOf(dirs, true); const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(data); await w.close();
    },
    async del(path) {
      try { const [dirs, name] = split(path); const d = await dirOf(dirs, false); await d.removeEntry(name); } catch (e) { if (!(e && e.name === "NotFoundError")) throw e; }
    },
    async list(prefix) {
      const out = [];
      const walk = async (dir, base) => { for await (const [name, h] of dir.entries()) { const p = base ? base + "/" + name : name; if (h.kind === "directory") await walk(h, p); else out.push(p); } };
      await walk(root, ""); return out.filter((k) => k.startsWith(prefix));
    },
  };
  // OPFS is only usable if a real write + read-back works here (Safari has the directory API but no writable stream on the main thread in many versions)
  const probe = new Uint8Array([1, 2, 3, 4]);
  await be.put(".probe/p.bin", probe.buffer);
  const back = await be.get(".probe/p.bin");
  await be.del(".probe/p.bin");
  if (!back || back.byteLength !== 4) throw new Error("opfs probe failed");
  return be;
}

/** @param {"auto"|"opfs"|"idb"} prefer  "auto" = OPFS if it really works, else IndexedDB. Returns {kind, why, get, put, del, list}. */
export async function openStore(prefer = "auto") {
  let why = "";
  if (prefer !== "idb") {
    if (!(navigator.storage && navigator.storage.getDirectory)) why = "OPFS non disponibile";
    else { try { const b = await opfsBackend(); b.why = ""; return b; } catch (e) { why = "OPFS non utilizzabile (" + (e && e.name || "errore") + ")"; } }
    if (prefer === "opfs") throw new Error(why);
  }
  if (!self.indexedDB) throw new Error("Nessuno storage disponibile nel browser");
  const b = await idbBackend(); b.why = why; return b;
}

/** Ask the browser not to evict the origin's storage (best effort; Safari/Chrome decide). */
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
export async function estimate() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
