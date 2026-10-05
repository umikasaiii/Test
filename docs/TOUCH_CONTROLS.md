# DSLink — Touch controls

Sistema di controlli touch definitivo, fedele al design approvato (4 layout: Nintendo DS e PlayStation 1,
verticale e orizzontale). Immagine d'insieme: `docs/img/touch-controls-layouts.png`.

Stato: **UI FREEZE V1** — **CODED / BUILD VERIFIED / LOCAL TESTED** (node --test 195/195, Chrome mobile emulation
118/118, PWA end-to-end 35/35). **DEVICE PENDING**: non ancora provato su telefoni reali.
Dopo questa versione i 4 layout sono congelati: solo bugfix o micro-regolazioni, nessun cambio di posizione o struttura.

## 1. Architettura (layout separato da input)

```
layouts.js    motore di layout puro (nessun DOM): computeLayout() -> rettangoli in px, aree di hit, schermo, stilo
components.js componenti DOM/SVG riusabili: D-pad, ABXY / △○✕□, spalle, pillole MENU/SELECT/START, FOCUS
input.js      InputRouter: pointer events -> pulsanti RetroPad / stilo / UI. Legge SOLO il layout, mai il DOM
menu.js       impostazioni (opacità, scala, vibrazione, schermi larghi) + menu di gioco
controls.js   mountControls(): collega layout + componenti + router + sink della sessione
controls.css  aspetto (navy scuro, vetro traslucido, glow, stato normale/premuto)
```

Il router riceve `sink = { btn(name, down), stylus(x, fy, down, move), ui(name) }`; `game.js` lo collega al
data channel esistente. Nessuna modifica a Runtime, emulazione o architettura (solo `cloud/gateway/runtime.go`:
mappa pad con `l2`/`r2` per PS1).

## 2. Layout

**Verticale** — spalle in alto (L/R, PS1: L1/L2 e R1/R2), schermo al centro, D-pad in basso a sinistra,
pulsanti azione in basso a destra, MENU / SELECT / START piccoli in basso al centro.

**Orizzontale** — colonna sinistra: L, MENU+SELECT, D-pad (in basso). Colonna destra: R, START+FOCUS, ABXY
(in basso). PS1: L1/L2, MENU/SELECT, D-pad; R1/R2, START + tasto aux, △○✕□. Lo schermo centrale occupa tutto
lo spazio rimasto.

## 3. Misure e gerarchia

Fattore dp `s = clamp(min(w,h)/390, 0.8, 1.25) × scalaUtente(0.8–1.2)`; in orizzontale limitato dal budget
delle colonne. Margine 14, gap 10, spalle 68×40 (PS1 54×40), pillole visibili 36, D-pad 116–140, cluster azioni 134–156
(pulsante azione visibile ≥ 48 px: 36% del cluster).
**Aree di tocco minime (px assoluti, mai ridotte dalla scala): D-pad / azioni / dorsali ≥ 48, MENU / SELECT / START / FOCUS ≥ 44.** Rispetta le safe-area (notch). Gerarchia: schermo >
D-pad/azioni > spalle > pillole di sistema.

## 4. Regole di input

- Multitouch per `pointerId`; D-pad a 8 direzioni con zona morta e guardia diagonale.
- Cluster azioni: scivolamento tra pulsanti e accordo di due pulsanti adiacenti.
- Stilo DS: mappato sulla metà bassa dell'intero frame (x 0..1, y 0.5..1).
- `releaseAll` su pointercancel / blur / visibilitychange / pagehide / cambio layout.
- Vibrazione tramite `navigator.vibrate` (opzionale).
- Impostazioni in `localStorage` (`dslink.controls.v1`).

Mappa RetroPad: B0 Y1 SELECT2 START3 UP4 DOWN5 LEFT6 RIGHT7 A8 X9 L10 R11 L2 12 R2 13.
Facce PS1: ✕=b, ○=a, □=y, △=x.

## 4b. D-pad (fedele alla reference)

Un'unica sagoma a croce (bracci larghi circa un terzo, angoli esterni arrotondati, raccordi interni morbidi), bordo
chiaro luminoso con glow, corpo in vetro blu-navy più chiaro verso le punte, incavo scuro al centro, alone circolare
tenue. Nessuna freccia/chevron: come nell'immagine approvata. Quattro overlay (`.arm`), ritagliati sulla sagoma,
illuminano solo la direzione premuta. La hit area resta quella del layout (8 direzioni, zona morta).

## 5. Decisioni (congelate)

- **Schermi DS**: il frame è un unico video 512×768 (due schermi 4:3 impilati). **Default: vero rapporto 4:3 per ciascuno dei due schermi** (immagine 2:3, nessuna deformazione). L'opzione "schermi più larghi" (Menu, card 2b dell'anteprima)
  stira l'immagine per riprodurre l'aspetto largo del mockup.
- **FOCUS**: DS = alterna schermo intero / solo sopra / solo sotto; PS1 = modalità immersiva: i controlli quasi nascosti (opacità 0,1) e tornano visibili al tocco per 2,5 s, restando sempre attivi.
- **PS1**: solo interfaccia; nel Runtime non c'è ancora un core PS1 (il gateway risponde 501).

## 6. Estensioni previste (V1 = 4 layout fissi)

Opacità e dimensione sono già regolabili. Predisposti: spostamento dei controlli, preset, nascondi/mostra,
analogico: basta aggiungere regole in `computeLayout()` e un componente; il router non cambia.

## 7. Test e anteprima

- `cd cloud/worker && node --test test/controls_layout.test.mjs` (geometria, hit area, notch)
- `cd cloud/tests && node controls_e2e.mjs <url>` (Chrome mobile, tocchi sintetici)
- `cd cloud/tests && node controls_shots.mjs <url> <dir>` (screenshot dei layout)
- Anteprima: `/controls-preview.html` e `?p=nds|ps1[&notch=1]` interattiva.
