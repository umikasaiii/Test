// GameSession: what the app talks to while a game runs, whatever the core. The page never names melonDS, PCSX-ReARMed or Emscripten: it asks the registry/resolver for a session
// and uses this interface.
//
//   start(opts)  pause(reason)  resume()  stop()  save(force)  getStats()  sendInput({type:"button"|"touch"|"analog", ...})
//
// Implementations: NDSGameSession (the DS player, unchanged) and PS1GameSession (ps1session.js). `Player` already implements the interface; the two classes below are the
// CoreAdapters the registry points at. A new system = a new subclass + a registry entry (coreregistry.js).
import { Player } from "./player.js";
import { PS1GameSession } from "./ps1session.js";
import { CORES } from "./coreregistry.js";

export class NDSGameSession extends Player {
  constructor(o) { super({ ...o, core: CORES.melonds }); }
}
export { PS1GameSession };

const ADAPTERS = { melonds: NDSGameSession, "pcsx-rearmed": PS1GameSession };
/** @param selection result of resolveRuntime() with ok === true */
export function createGameSession(selection, opts) {
  const A = ADAPTERS[selection.coreId];
  if (!A) throw new Error("no adapter for " + selection.coreId);
  return new A(opts);
}
