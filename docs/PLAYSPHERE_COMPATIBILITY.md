# PlaySphere — matrice di compatibilità

Qui compare solo ciò che è stato **verificato**. Una cella vuota o "non verificato" significa che non lo sappiamo.

| Sistema | Core | Stato | Come è stato verificato |
|---|---|---|---|
| Nintendo DS | melonDS (WASM) | funziona (invariato) | suite di regressione (single player, save, Cloud, Download Play, multiplayer Internet) |
| PlayStation 1 | PCSX-ReARMed (WASM) | **funziona con il programma di test del progetto** | boot, video, audio, input, memory card, cue/bin, chd, multi-disco, save state — solo disco redistribuibile, browser Chromium desktop senza GPU |
| PS1 — giochi commerciali | — | **non verificato** | nessun gioco commerciale provato |
| PS1 — BIOS Sony reale | — | **non verificato** | solo HLE nei test |
| Honor 200 / iPhone (PS1) | — | **non verificato** | nessun dispositivo fisico |
| Gamepad fisico reale | — | non verificato | solo Gamepad API simulata |
| GB, GBC, GBA, NES, SNES, N64, PSP | — | non disponibili | non mostrati nell'app |

Formati PS1 verificati: `.cue`+`.bin`, `.chd`, `.m3u` multi-disco (con il disco di test). Prestazioni misurate: 60 fps su un runner CI senza GPU per il programma di test; **nessun dato** su telefoni.
