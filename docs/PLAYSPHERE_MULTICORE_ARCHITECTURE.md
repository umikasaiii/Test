# PlaySphere — architettura multi-core

**PlaySphere** è il nome ufficiale mostrato all'utente (documentazione e interfaccia nuove). Il nome tecnico storico resta in repository, package, appId, chiavi di storage, deep link, CI e risorse Cloudflare: vedi [Debito tecnico](#debito-tecnico-legacy_dslink_identifier).

Obiettivo: una sola libreria, un solo player, un solo sistema di account/amici/presenza/Cloud; il runtime dipende dal gioco e **l'utente non sceglie mai un core**.

```
Libreria (IndexedDB/OPFS + Cloud metadata)
   └─ GameProfile            gameprofile.js   (platform, region, productCode, coreId, inputProfile, saveProfile, discMetadata…)
        └─ RuntimeResolver   runtimeresolver.js  (profile + DeviceCapabilities + prefs → RuntimeSelection | motivo chiaro)
             └─ CoreRegistry coreregistry.js   (UNICO posto che conosce i core)
                  └─ GameSession  gamesession.js
                       ├─ NDSGameSession  = Player (melonDS WASM)         emulator.worker.js
                       └─ PS1GameSession  (PCSX-ReARMed WASM)             ps1.worker.js
```

## Moduli (`cloud/web/play/`)

| Modulo | Responsabilità |
|---|---|
| `coreregistry.js` | `CORES`, `RUNTIMES` (`LOCAL_NDS_WASM`, `LOCAL_PS1_WASM`), `PLATFORMS` (NDS, PS1), `FUTURE_PLATFORMS` (solo nello schema: NES SNES GB GBC GBA N64 PSP — **mai** mostrate, nessun placeholder). Nessun `switch` sul nome del core altrove. |
| `gameprofile.js` | `profileOf(meta)`, `gameIdOf`, `regionOf`. Le voci DS vecchie senza `platform` sono DS. L'id Cloud è `nds-<codice>` / `ps1-<seriale>`. |
| `runtimeresolver.js` | `resolveRuntime`, `deviceCapabilities` (wasm, SIMD, module worker, gamepad…). Se manca una capacità obbligatoria restituisce `{ok:false, reason}` con messaggio leggibile; nessun crash. |
| `gamesession.js` | `createGameSession(selection, opts)`; contratto `start / pause / resume / stop / save / getStats / sendInput`. |
| `inputprofile.js` | `NDS_STANDARD`, `PS1_DIGITAL`, `PS1_DUALSHOCK`; bit RetroPad comuni. |
| `avpipe.js` | pipeline audio/video condivisa dal worker PS1 (anello audio, frame). L'audio DS usa la sua infrastruttura invariata. |
| `gamepad.js` | Gamepad API (mapping standard, 2 pad → porte 0/1). |
| `ps1*.js` | import (cue/bin/chd/m3u), BIOS, sessione, UI. |

Aggiungere un sistema = una voce nel registry + un adapter (sottoclasse di sessione) + una build WASM + un `InputProfile`. Libreria, storage, salvataggi, Cloud, social e Party Voice non cambiano.

## Il core PS1 è caricato a richiesta

* `core/ps1/playsphere_ps1.{js,wasm}` + `build-info.json` si scaricano solo quando si avvia un gioco PS1 (o quando il service worker lo prefetch dopo il primo uso).
* Il service worker salva i **tre file insieme** nella cache della build: se uno manca si usa la rete, mai una combinazione mista (versionamento atomico). `build-info.json` contiene `id, coreVersion, license, api, stateFormat`; il worker rifiuta un core con `api` diverso da quello atteso.
* Cambio di runtime (DS→PS1→DS): `stop()` termina il worker, chiude l'`AudioContext`, rilascia gli URL oggetto; test `play_multicore_e2e.mjs` verifica nessun worker/audio zombie, storage e salvataggi separati, UI e input profile corretti, memoria prima/dopo.

## Salvataggi

| | DS | PS1 |
|---|---|---|
| Dati | SRAM (`library/<id>/save`) | memory card 128 KiB (`library/<id>/save`) |
| Cloud Save | sì (revisioni, conflitti, restore) | sì, stesso meccanismo, `gameId = ps1-<seriale>` |
| Save state | — | slot 1–5, **locali**, versionati (core id, versione, formato, dimensione); uno stato incompatibile è rifiutato; non sincronizzati |

## Modalità di disponibilità

LOCALE (file solo sul dispositivo), CLOUD (metadata + BIOS/salvataggi su R2) e LOCALE+CLOUD. Per PS1 le immagini disco **non** sono caricate su R2 (non implementato): il Cloud contiene metadata `platform=PS1`, memory card e BIOS privato. Offline: la PWA e i giochi locali funzionano senza rete.

## Presenza, inviti, Party Voice

La presenza "IN GAME · titolo" è indipendente dal core. Non compare "INVITA A GIOCARE" per giochi senza multiplayer PlaySphere (PS1 non ne ha). Party Voice (P2P mesh) sopravvive all'avvio e allo stop di un gioco PS1.

## Cosa NON c'è

Nessun PlaySphere PC Remote: nessuna RemoteGameSession, Windows Host, streaming PC, display virtuale, NVENC, RPCS3/PCSX2 remoto. Le astrazioni qui sopra esistono solo perché servono a DS + PS1.

## Debito tecnico: `LEGACY_DSLINK_IDENTIFIER`

Per non rompere installazioni, dati e deploy esistenti **non** sono stati rinominati: nome del repository, package npm, appId Android, chiavi `localStorage`/IndexedDB/cache, deep link, nomi dei workflow CI, risorse Cloudflare (Worker, D1, R2, Durable Objects), identificatori persistenti nel DB, nomi interni `dslink*`/`DSLink`. Qualsiasi rinomina futura richiede una migrazione dedicata (dati, cache del service worker, credenziali, deploy) e non fa parte di questa fase.
