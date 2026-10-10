# PlaySphere — decisione del core PlayStation 1

Stato: **scelto e integrato** (FASE 8). Core: **PCSX-ReARMed** (libretro), commit `c8816799b50388e61cfe237fe2cdbb7d8175f20a` (2026-10-02), compilato in WebAssembly da `scripts/build_ps1_wasm.sh`.

## Metodo

Non è stato scelto un nome "per fama". Per ogni candidato sono stati clonati i sorgenti (profondità 1) e verificati: licenza (file `COPYING`/`LICENSE` e intestazioni dei sorgenti), presenza di un target Emscripten nel build system, dipendenze da thread/JIT/OpenGL, formati disco, BIOS, memory card, multi-disco, input analogico. Dove un punto non è stato misurato qui sotto è scritto così.

## Candidati

| | PCSX-ReARMed | SwanStation (DuckStation) | Beetle PSX (Mednafen) |
|---|---|---|---|
| Licenza | **GPL-2.0-or-later** (ogni file con intestazione GPL dice "or later"; verificato su 125 file) + libchdr BSD-3, libretro-common MIT | GPL-3.0 | GPL-2.0 |
| Target WebAssembly | **`platform=emscripten` ufficiale in `Makefile.libretro`** (interprete, niente dynarec, niente thread, GPU "neon" via SIMD) | nessuno; CMake con thread obbligatori (`find_package(Threads REQUIRED)`), CPU interprete lento senza JIT, renderer software pesante | `platform=emscripten` presente ma con OpenGL/GLES (`HAVE_OPENGL=1 GLES3`) per il renderer HW; software renderer accurato ma molto più lento |
| Dipendenze browser | WebAssembly + SIMD128 (Chrome 91+, Safari 16.4+, Firefox 89+); nessun SharedArrayBuffer, nessun thread | thread (SharedArrayBuffer + isolamento), GPU API | WebGL2 per il percorso HW |
| Dimensione build | **1.0 MB `.wasm`** (misurata) | non compilato qui | non compilato qui |
| Formati | cue/bin, **chd** (libchdr), iso/img, m3u, pbp, exe | cue/bin, chd, m3u, pbp | cue/bin, chd, m3u, pbp |
| BIOS | BIOS reale (qualsiasi regione) **oppure HLE integrato** | BIOS reale o HLE "OpenBIOS" | richiede BIOS reale |
| Memory card | sì (`RETRO_MEMORY_SAVE_RAM` = 128 KiB) | sì | sì |
| Multi-disco | sì: m3u + disk control interface (`SET_DISK_CONTROL_EXT_INTERFACE`) | sì | sì |
| Analogico / DualShock | sì (DualShock, vibrazione, toggle analogico) | sì | sì |
| Save state | sì (`retro_serialize`, 4.4 MiB misurati) | sì | sì |
| Accuratezza | media (HLE possibile, GPU non cycle-accurate) | alta | molto alta |
| Prestazioni attese in WebAssembly | **60 fps misurati** per il programma di test su un runner senza GPU hardware (3 ms/frame) | non misurate; senza JIT l'interprete è il collo di bottiglia | non misurate; il renderer software accurato è il più lento |
| Manutenzione | attiva (ultimo commit 2026-10-02) | attiva (2026-10-08) | attiva (2026-10-06) |

## Decisione

**PCSX-ReARMed.** È l'unico dei tre che soddisfa insieme: build WebAssembly **supportata a monte** (nessuna patch di architettura), niente thread (la PWA non può contare su `SharedArrayBuffer` su ogni iPhone), licenza compatibile con quella del progetto, dimensione e prestazioni adatte a un telefono, e tutte le funzioni richieste da PlaySphere (CHD, multi-disco con disk control, memory card, DualShock, save state).

Il prezzo è l'accuratezza: PCSX-ReARMed è meno preciso di Beetle/SwanStation. PlaySphere non lo nasconde: la tabella di compatibilità (`PLAYSPHERE_COMPATIBILITY.md`) non dichiara compatibilità di giochi commerciali, e `docs/PLAYSPHERE_PS1.md` elenca i limiti. Se in futuro serve più accuratezza, il core si sostituisce aggiungendo un'altra voce al registry (`cloud/web/play/coreregistry.js`) senza toccare il resto dell'app.

## Licenza (verificata PRIMA dell'integrazione)

* **PCSX-ReARMed: GPL-2.0-or-later.** Il progetto PlaySphere/DSLink è GPL-3.0 (come il core melonDS DS): codice GPL-2.0-or-later si può combinare in un'opera GPL-3.0. Nessun file del core compilato per WebAssembly è "GPL-2.0-only" (controllato: ogni file con intestazione GPL contiene "or later"; `psxbios.c` incorpora la stringa `GPL-2.0-or-later` nell'immagine BIOS HLE).
* **libchdr** (decodifica CHD): BSD-3-Clause, inclusa nel sorgente del core. **libretro-common**: MIT. **miniz** (zlib per CHD): MIT.
* **Obblighi di distribuzione**: il file `.wasm` del core è distribuito con la PWA; i sorgenti corrispondenti sono il commit fissato in `upstream/versions.env` (`PCSX_REARMED_COMMIT`) più la patch `wasm/ps1/patches/0001-emscripten-miniz.patch` e il wrapper in `wasm/ps1/` + `runtime/src/libretro_host.*`, tutti nel repository GPL-3.0. `build-info.json` accanto al core dichiara versione, commit e licenza. Un utente può ricostruire lo stesso binario con `scripts/build_ps1_wasm.sh`.
* **Modifiche necessarie**: una sola patch al Makefile del core (usare `miniz` incluso invece della "port" zlib di Emscripten, che richiede un download di rete a tempo di build). Nessuna modifica al codice dell'emulatore.
* **Incompatibilità potenziali**: nessuna trovata. Nota: **SwanStation (GPL-3.0)** sarebbe stata compatibile col progetto, **Beetle PSX (GPL-2.0, "only" per parti di Mednafen)** richiederebbe una verifica file per file prima di essere combinata con codice GPL-3.0.
* **Materiale proprietario**: nessuno nel repository. Niente BIOS Sony, niente giochi. Il BIOS HLE incluso nel core è codice del progetto PCSX, non un file Sony.

## Cosa NON è stato verificato

* Nessun gioco commerciale è stato provato (vincolo: nessun contenuto proprietario in CI e nessun gioco disponibile qui). La compatibilità reale con titoli commerciali è sconosciuta.
* SwanStation e Beetle PSX non sono stati compilati: la scelta si basa su build system, licenza e architettura, non su una misura di prestazioni.
* Nessuna misura su Honor 200 o iPhone.
