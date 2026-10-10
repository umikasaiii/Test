# PlaySphere — design system (FASE 9)

One stylesheet, `cloud/web/play/playsphere.css`, loaded after the legacy `mp.css` and `play.css`. It defines the tokens, remaps the legacy variables onto them (so every older screen follows the same palette), and holds all shared components. The in-game touch controls (`cloud/worker/public/controls`) are **frozen** and not edited: their look is only extended from the outside (press feedback, menu sheet) and their geometry is checked by `cloud/tests/controls_geometry_probe.mjs --check`.

Visual reference: the concept supplied for the project (blue / cyan / violet, glass cards, soft glow, rounded surfaces). It is a style reference, not a mock-up to copy: every screen shows only what the product really does.

## Tokens (all in `:root`, never hard-coded elsewhere)

| Group | Tokens |
|---|---|
| Colour | `--ps-primary`, `--ps-primary-strong`, `--ps-secondary`, `--ps-accent`, `--ps-bg`, `--ps-bg-2`, `--ps-bg-image`, `--ps-surface`, `--ps-surface-elevated`, `--ps-surface-solid`, `--ps-surface-sunken`, `--ps-border`, `--ps-border-strong`, `--ps-text`, `--ps-text-muted`, `--ps-text-on-primary`, `--ps-success`, `--ps-warning`, `--ps-danger`, `--ps-info`, `--ps-grad-primary`, `--ps-grad-accent` |
| Typography | `--ps-font` (system stack, no web font: nothing to download, no licence to carry), `--ps-mono`, `--ps-fs-xs … --ps-fs-2xl`, `--ps-fw-*`, `--ps-lh` |
| Spacing | `--ps-s1 … --ps-s8` (4, 8, 12, 16, 20, 24, 32 px), safe-area aware gutters |
| Radius | `--ps-r-sm / md / lg / xl / pill` |
| Shadow / elevation | `--ps-shadow-1 / 2 / 3`, `--ps-glow`, `--ps-scrim` |
| Blur | `--ps-blur`, `--ps-blur-strong` (both `0` in lite mode and while a game runs) |
| Motion | `--ps-dur-fast / dur / dur-slow`, `--ps-ease`, `--ps-ease-spring` |
| State | `--ps-state-hover`, `--ps-state-press`, `--ps-state-disabled`, `--ps-focus`, skeleton colours |

## Themes

`html[data-theme="dark" | "light"]`, set before the first paint by a tiny script in `index.html` from `localStorage["ps.theme"]` (`dark` default, `light`, `system`). Both are the same layout and the same components; light is a sky-blue variant with white glass. `test/play_ui_e2e.mjs` checks, from the computed tokens, that every text/background pair reaches WCAG AA (4.5:1) in both themes.

## Components

Buttons (`.cta`, `.cta.primary`, `.mini`, `.ps-iconbtn`), chips and the segmented control (`.chip`, `.ps-seg`), cards (`.ps-card`), game cards (`ul.ps-grid li.game` with a generated cover), rails (`.ps-rail`), avatars with status (`.ps-avatar`), badges (`.ps-badge`, `.tag`, `.plat`, `.pres`), empty states (`.ps-empty`), skeletons and progress (`.ps-skel`, `.ps-indet`, `progress`), bottom sheet and dialogs (`.overlay.sheet`, `.card`), toasts (`#cloudToast`), the party mini panel (`.pbar`), the navigation (`#psNav`: bottom bar on phones, side rail on a phone in landscape, sidebar on tablet / desktop ≥ 900 px).

Icons: one inline SVG sprite in `index.html` (`#i-*`, 24 px grid, 1.8 stroke, round caps), no icon font and no external set. Brand: `tools/brand/mark.svg` (sphere with an orbital ring, blue → cyan → violet) rendered by `tools/brand/make_icons.mjs` to the PWA icons (192, 512, maskable 512, apple-touch 180, favicon 32) plus `icons/logo.svg`. No third-party artwork is embedded; games without artwork get a generated cover (gradient + initials) — never commercial artwork.

## Motion and effects

Screen and sheet transitions 200–340 ms, press feedback 60–120 ms. `prefers-reduced-motion` removes every animation. **Lite mode** (automatic on ≤ 4 cores / ≤ 2 GB memory / reduced-transparency, or from Impostazioni › Riduci gli effetti) removes blur, the animated background and translucent surfaces. While a game runs (`body[data-screen="game"]`) the decorative background is removed and the blur tokens are `0px`: the core, the audio and the input have all the frame budget.

## Adding to it

New colours go in the two token blocks only. New components use tokens; a literal colour in a component is a bug. The only literals left outside the token blocks are the in-game stage (`.ctl-*`, `.ps1-*`), which keep the approved dark look in both themes.
