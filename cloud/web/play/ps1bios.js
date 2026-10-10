// PlayStation BIOS files: provided by the user, kept on this device (and, if the user chooses, in their PRIVATE Cloud). Never in the repository, the app, an artifact or a log.
// A BIOS is recognised by its content (a 512 KiB ROM that carries the "System ROM Version x.y dd/mm/yy R" string, R = A America, E Europe, J Japan), not by its name.
// PlaySphere never pretends the built-in HLE BIOS is equivalent: without a BIOS the game does not start unless the user explicitly chooses reduced-compatibility mode.
export const BIOS_SLOTS = Object.freeze([
  { key: "ps1bios_na", file: "ps1-bios-na.bin", title: "BIOS PlayStation (America)", region: "NTSC-U", letter: "A", coreName: "scph5501.bin" },
  { key: "ps1bios_eu", file: "ps1-bios-eu.bin", title: "BIOS PlayStation (Europa)", region: "PAL", letter: "E", coreName: "scph5502.bin" },
  { key: "ps1bios_jp", file: "ps1-bios-jp.bin", title: "BIOS PlayStation (Giappone)", region: "NTSC-J", letter: "J", coreName: "scph5500.bin" },
]);
export const BIOS_SIZE = 524288;
export const slotOfRegion = (r) => BIOS_SLOTS.find((s) => s.region === r) || null;

/** @returns {{ok:true, slot:object, version:string, date:string} | {ok:false, error:string}} - error codes: size, not_bios */
export function inspectBios(buf) {
  if (!buf || buf.byteLength !== BIOS_SIZE) return { ok: false, error: "size" };
  const text = new TextDecoder("latin1").decode(new Uint8Array(buf));
  const m = /System ROM Version (\d\.\d) (\d\d\/\d\d\/\d\d) ([AEJ])/.exec(text);
  if (!m) return { ok: false, error: "not_bios" };
  const slot = BIOS_SLOTS.find((s) => s.letter === m[3]);
  return { ok: true, slot, version: m[1], date: m[2] };
}

export const BIOS_ERR = { size: "Un BIOS PlayStation è un file da 512 KB: questo file ha un'altra dimensione.", not_bios: "Questo file non sembra un BIOS PlayStation." };

/**
 * What the core is given for a game of `region`: every BIOS the user has (the core picks the one for the game's region), and a verdict.
 * @param {Map<string,ArrayBuffer>} have  slot.key -> content
 * @returns {{status:"match"|"other"|"none", files:Object<string,ArrayBuffer>, used:string[]}}
 */
export function biosForGame(region, have) {
  const files = {}, used = [];
  for (const s of BIOS_SLOTS) { const b = have.get(s.key); if (b) { files[s.coreName] = b; used.push(s.key); } }
  const want = slotOfRegion(region);
  if (!used.length) return { status: "none", files, used };
  return { status: want && used.includes(want.key) ? "match" : "other", files, used };
}
