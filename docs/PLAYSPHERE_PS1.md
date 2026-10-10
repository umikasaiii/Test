# PlaySphere — PlayStation 1

Core: **PCSX-ReARMed** (libretro) compilato in WebAssembly — motivazione e licenza in [PLAYSPHERE_PS1_CORE_DECISION.md](PLAYSPHERE_PS1_CORE_DECISION.md). L'architettura generale è in [PLAYSPHERE_MULTICORE_ARCHITECTURE.md](PLAYSPHERE_MULTICORE_ARCHITECTURE.md).

## Requisiti del dispositivo
WebAssembly + **SIMD** + module worker. Se manca qualcosa l'app lo dice con un messaggio chiaro e non avvia il gioco. Nessun `SharedArrayBuffer` richiesto per PS1.

## Build del core
`scripts/build_ps1_wasm.sh` scarica il commit fissato in `upstream/versions.env`, applica `wasm/ps1/patches/`, compila con Emscripten 3.1.74 e scrive `build/pwa/core/ps1/` + `build-info.json`. Il repository non contiene ROM, BIOS né dischi.

## Cosa serve all'utente
1. **Disco**: `.cue` + `.bin` (un solo gioco, anche con più tracce), `.chd` (consigliato, non obbligatorio), `.m3u` per più dischi. L'import riconosce da solo la piattaforma. I file restano sul dispositivo: vengono letti a blocchi (WORKERFS) senza copiare l'intero disco in memoria.
2. **BIOS** (opzionale ma raccomandata): file forniti dall'utente (`scph5500/5501/5502/1001/7001`), validati per dimensione/contenuto, salvati in locale e, se l'utente lo vuole, nel **Cloud privato** (`ps1-bios-{na,eu,jp}.bin`). Senza BIOS l'app chiede il consenso esplicito per usare l'**HLE** integrato nel core: non viene mai attivato in silenzio.

## Funzioni
* Video NTSC 60 Hz / PAL 50 Hz (il PAL non è forzato a 60), aspetto corretto di default; RGB565/1555 convertito.
* Audio 44.1 kHz con la stessa infrastruttura di anello/AudioContext dell'app.
* Input: tasti digitali touch (layout PS1), tastiera, gamepad fisici (2 pad); DualShock con stick analogici virtuali **solo** quando il gioco/profilo li usa; vibrazione se disponibile (feature detect).
* Memory card persistente (`library/<id>/save`), Cloud Save con revisioni/conflitti/restore; save state slot 1–5 locali e versionati.
* Multi-disco: menu → **CAMBIA DISCO** (API disk control del core).
* Overlay sviluppatore: fps emulazione/render, frame time, underrun audio, memoria WASM, stall, core e versione, backend video.
* UI Touch V1 del DS **congelata**: il menu PS1 si aggiunge dall'esterno, `cloud/worker/public/controls` non è modificato.

## Limiti noti (onesti)
* BIOS Sony reale: **non verificato** (la BIOS non può stare nel repository né in CI); i test usano HLE con consenso esplicito.
* Immagini disco non caricate su Cloud (non implementato).
* Vibrazione: verificato solo il collegamento (il programma di test non vibra).
* Gamepad fisico: testato con Gamepad API simulata, non con hardware reale.
* Nessuna verifica su Honor/iPhone reali, nessuna dichiarazione di prestazioni mobili.
* Compatibilità con giochi commerciali sconosciuta: vedi [PLAYSPHERE_COMPATIBILITY.md](PLAYSPHERE_COMPATIBILITY.md).

## Test
`cloud/tests/play_ps1_e2e.mjs` (boot, video NTSC/PAL, audio, input digitale/analogico/gamepad, memory card + reload, bin/cue, chd, multi-disco, cambio disco, save state), `play_multicore_e2e.mjs`, `play_ps1_cloud_e2e.mjs`, `play_ps1_offline.mjs`. Il disco di test è un programma PS-X EXE scritto per il progetto (`tools/ps1/`), generato da `tools/ps1/mkdisc.py`: nessun contenuto commerciale in CI.
