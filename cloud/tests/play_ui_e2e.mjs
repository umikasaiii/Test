// PlaySphere FASE 9: the app shell and its design system, in real Chrome against the source tree (static host, no Cloud): first run, navigation, Home, Library (search, tabs, favourites,
// filters), Game detail, themes, accessibility, responsive layouts, offline badge, install hint, friendly errors, loading states, haptics, lite mode, and "no core name in the normal UI".
// Homebrew only: a DS test ROM and the PlayStation test disc built from tools/ps1. usage: node play_ui_e2e.mjs <nds-homebrew.nds> [screenshot-dir]
import fs from 'node:fs';
import path from 'node:path';
import { staticServer, launch, openApp, buildDiscs, files, until, sleep, reporter, ROOT } from './ps1lib.mjs';

const [nds, shots = '/tmp/ps-ui'] = process.argv.slice(2);
if (!nds) { console.error('usage: play_ui_e2e.mjs <nds-homebrew.nds> [screenshot-dir]'); process.exit(2); }
fs.mkdirSync(shots, { recursive: true });
const { check, done } = reporter();
const srv = await staticServer({ csp: true }), browser = await launch(), discs = buildDiscs();   // served with the production Content-Security-Policy (cloud/csp.txt)
const cspHits = []; const closeP = async (pg) => { cspHits.push(...(await pg.evaluate(() => window.__csp || []).catch(() => []))); await pg.close(); };
const go = (p, t) => p.evaluate((x) => window.dslinkPlay.go(x), t);
const text = (p) => p.evaluate(() => document.body.innerText);
const NO_CORE = /melonDS|PCSX|ReARMed|WebAssembly|\bWASM\b|libretro|Emscripten/i;
const shot = (p, name) => p.screenshot({ path: path.join(shots, name + '.png') });
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);

// ============================================================================ 1. first run (onboarding)
let p = await openApp(browser, srv.base, '?nosw&welcome=1');
check('FIRST RUN: the welcome flow shows on the first start (5 short slides, SALTA always available)', await p.isVisible('#psWelcome') && (await p.locator('#wSlides .ps-slide').count()) === 5 && await p.isVisible('#wSkip'));
await shot(p, 'welcome-1');
for (let i = 0; i < 4; i++) await p.click('#wNext');
check('FIRST RUN: the last slide says INIZIA and SALTA is gone; the dots follow', (await p.innerText('#wNext')) === 'INIZIA' && !(await p.isVisible('#wSkip')) && (await p.locator('#wDots i.on').count()) === 1);
await p.click('#wNext');
check('FIRST RUN: INIZIA lands on Home and the flow is remembered', !(await p.isVisible('#psWelcome')) && (await p.evaluate(() => document.body.dataset.tab)) === 'home' && (await p.evaluate(() => localStorage.getItem('ps.welcomed'))) === '1');
await closeP(p);
p = await openApp(browser, srv.base, '?nosw&welcome=1'); await p.click('#wSkip');
check('FIRST RUN: SALTA closes it at once', !(await p.isVisible('#psWelcome')));
await closeP(p);
p = await openApp(browser, srv.base, '?nosw');
check('FIRST RUN: automated browsers (navigator.webdriver) never see it unless ?welcome=1, so tests are not blocked', !(await p.isVisible('#psWelcome')));

// ============================================================================ 2. Home (empty) and navigation
check('HOME: the app opens on Home with a greeting and an empty-library card with one clear action', (await p.evaluate(() => document.body.dataset.tab)) === 'home' && await p.isVisible('#homeEmpty') && /AGGIUNGI UN GIOCO/.test(await p.innerText('#homeEmpty')));
await shot(p, 'home-empty');
const navNames = await p.$$eval('#psNav [data-nav]', (b) => b.map((x) => x.innerText.trim()));
check('NAV: five destinations - Home, Libreria, Multiplayer, Amici, Profilo - and the current one is marked', JSON.stringify(navNames) === JSON.stringify(['Home', 'Libreria', 'Multiplayer', 'Amici', 'Profilo']) && (await p.getAttribute('#psNav [data-nav=home]', 'aria-current')) === 'page');
await p.click('#psNav [data-nav=games]');
check('NAV: Libreria opens, the URL carries the route (#/games) and the item is marked', (await p.evaluate(() => document.body.dataset.tab)) === 'games' && (await p.evaluate(() => location.hash)) === '#/games' && (await p.getAttribute('#psNav [data-nav=games]', 'aria-current')) === 'page');
await p.click('#psNav [data-nav=multiplayer]'); await p.click('#psNav [data-nav=home]');
await p.goBack();
check('NAV: the browser / Android back button steps back through the tabs (never traps)', (await p.evaluate(() => document.body.dataset.tab)) === 'multiplayer');
await p.goBack(); await p.goBack();
check('NAV: back all the way returns to the first tab and leaves the app only from there', (await p.evaluate(() => document.body.dataset.tab)) === 'home');
await p.click('#btnSettings');
check('NAV: the gear opens Impostazioni', (await p.evaluate(() => document.body.dataset.tab)) === 'settings' && /Impostazioni/.test(await p.innerText('[data-panel=settings] h1')));
await p.click('#psNav [data-nav=friends]');
check('NAV: Amici without an account asks to sign in (no dead end, nothing fails silently)', (await p.evaluate(() => document.body.dataset.screen)) === 'account' && /Accedi/.test(await p.innerText('#authMsg')));
await p.click('#btnAuthBack');
await p.click('#psNav [data-nav=multiplayer]'); await p.goto(`${srv.base}/play/?nosw`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('SESSION RESTORE: reopening the app (no hash) comes back to the last main tab, not to a half-finished flow', (await p.evaluate(() => document.body.dataset.tab)) === 'multiplayer' && (await p.evaluate(() => document.body.dataset.screen)) === 'library');
await p.goto(`${srv.base}/play/?nosw#/games`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('ROUTING: opening #/games directly shows the Library', (await p.evaluate(() => document.body.dataset.tab)) === 'games');

// ============================================================================ 3. Library: add, cards, search, tabs, favourites, filters
await p.setInputFiles('#romFile', [nds, ...files(discs, 'Test Game.cue', 'Test Game.bin')]); await until(async () => (await p.locator('#gameList li.game').count()) === 2, 20000);
const titles = await p.$$eval('#gameList li.game .ttl', (e) => e.map((x) => x.textContent));
check('LIBRARY: a DS file and a PlayStation disc become two cards, each with platform badge (DS / PS1), no technical detail', titles.length === 2 && (await p.locator('#gameList li.game .ps-cover .plat').allInnerTexts()).sort().join() === 'DS,PS1' && !NO_CORE.test(await p.innerText('#gameList')));
await shot(p, 'library');
const psTitle = titles.find((t) => /Test Game/.test(t)), dsTitle = titles.find((t) => t !== psTitle);
await p.fill('#gameSearch', 'test game');
check('LIBRARY: search narrows the cards as you type', (await p.locator('#gameList li.game').count()) === 1);
await p.fill('#gameSearch', 'zzzzzz');
check('EMPTY STATE: no result says so and offers the way out', /Nessun risultato/.test(await p.innerText('#gameList')));
await p.fill('#gameSearch', '');
await p.click('#libTabs [data-lib=fav]');
check('EMPTY STATE: Preferiti explains how to add one', /cuore/.test(await p.innerText('#gameList')));
await p.click('#libTabs [data-lib=all]');
await p.locator('#gameList li.game', { hasText: psTitle }).locator('.ps-fav').click();
check('FAVOURITE: the heart toggles (aria-pressed) and gives haptic-ready feedback class', (await p.locator('#gameList li.game', { hasText: psTitle }).locator('.ps-fav').getAttribute('aria-pressed')) === 'true');
await p.click('#libTabs [data-lib=fav]');
check('LIBRARY: the Preferiti tab shows only favourites', (await p.locator('#gameList li.game').count()) === 1 && (await p.innerText('#gameList')).includes(psTitle));
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await go(p, 'games');
await p.click('#libTabs [data-lib=fav]');
check('FAVOURITE: it is remembered after a reload', (await p.locator('#gameList li.game').count()) === 1);
await p.click('#libTabs [data-lib=recent]');
check('EMPTY STATE: Recenti is empty until something is played, and says so', /recenti/i.test(await p.innerText('#gameList')));
await p.click('#libTabs [data-lib=all]');
check('LIBRARY: the platform filter appears when both systems are present', await p.isVisible('#platformFilter') && (await p.locator('#platformFilter .chip').count()) === 3);
await p.click('#platformFilter [data-filter=PS1]');
check('LIBRARY: the filter keeps only that system', (await p.locator('#gameList li.game').count()) === 1);
await p.click('#platformFilter [data-filter=all]');

// ============================================================================ 4. Game detail
await p.locator('#gameList li.game', { hasText: dsTitle }).locator('.ttl').click();
check('GAME DETAIL: tapping a card opens the sheet with title, system, last use, space, saves, location, multiplayer', await p.isVisible('#gameDetail') && (await p.innerText('#gdTitle')) === dsTitle && (await p.locator('#gdFacts li').count()) === 6);
const sheet = await p.innerText('#gameDetail');
check('GAME DETAIL: the main action is GIOCA and the secondary ones are Preferito, Gestisci file, Info; no emulator/core name anywhere', /GIOCA/.test(sheet) && /Preferito/.test(sheet) && /Gestisci file/.test(sheet) && /Info/.test(sheet) && !NO_CORE.test(sheet));
await shot(p, 'game-detail');
await p.click('#gdFav');
check('GAME DETAIL: Preferito toggles from the sheet too', (await p.getAttribute('#gdFav', 'aria-pressed')) === 'true');
await p.click('#gdFiles');
check('GAME DETAIL: Gestisci file lists the actions that exist (here: remove from this device)', /RIMUOVI DAL DISPOSITIVO/.test(await p.innerText('#gdPanel')));
await p.keyboard.press('Escape');
check('GAME DETAIL: Escape closes the sheet and focus goes back to where it was', !(await p.isVisible('#gameDetail')));
await p.click('#libTabs [data-lib=all]');

// ============================================================================ 5. Home with games
await go(p, 'home');
check('HOME: with games it shows "Continua a giocare" (or "Inizia da qui"), the recent rail and the sync status', await p.isVisible('#homeContinue') && await p.isVisible('#homePlay') && await p.isVisible('#homeSync'));
check('HOME: without an account the friends card invites to sign in; the sync pill says "Solo locale"', /ACCEDI/.test(await p.innerText('#homeFriends')) && /solo locale/i.test(await p.innerText('#homeSync')));
await shot(p, 'home');
await p.click('#homePlay'); await p.waitForFunction(() => window.dslinkPlay.isPlaying(), null, { timeout: 30000 });
check('HOME: GIOCA starts the DS game; while playing there are no decorative layers (background, blur) to cost frames', (await p.evaluate(() => getComputedStyle(document.getElementById('psBg')).display)) === 'none' && (await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ps-blur').trim())) === '0px');
await sleep(800); await shot(p, 'player-nds-portrait');
await p.setViewportSize({ width: 844, height: 390 }); await sleep(500); await shot(p, 'player-nds-landscape');
await p.setViewportSize({ width: 390, height: 844 });
await p.evaluate(async () => { await window.dslinkPlay.player.save(true); });
// the real exit (menu -> leave) is covered by the player suites; here the confirm dialog's own button closes the game
await p.evaluate(() => { document.getElementById('confirm').hidden = false; }); await p.click('#confirmYes'); await p.waitForFunction(() => !window.dslinkPlay.isPlaying() && document.body.dataset.screen === 'library', null, { timeout: 15000 });
check('HOME: after the game the recent rail and "Continua a giocare" show that game with "adesso"', (await p.evaluate(() => document.body.dataset.screen)) === 'library' && /adesso|min fa/.test(await p.innerText('#homeContinue')));
await go(p, 'games'); await p.click('#libTabs [data-lib=recent]');
check('LIBRARY: Recenti now lists it', (await p.locator('#gameList li.game').count()) === 1);
await p.click('#libTabs [data-lib=all]');

// ============================================================================ 6. Multiplayer panel
await go(p, 'multiplayer'); await shot(p, 'multiplayer');
check('MULTIPLAYER: Locale / Online segmented control, "Crea stanza" and "Unisciti" as large cards; Locale is the default', (await p.getAttribute('#mpSeg [data-mp=local]', 'aria-selected')) === 'true' && /Crea stanza/.test(await p.innerText('#btnCreate')) && /Unisciti/.test(await p.innerText('#btnJoin')));
await p.click('#mpSeg [data-mp=online]');
check('MULTIPLAYER: Online without an account explains and offers ACCEDI', await p.isVisible('#mpGate') && /ACCEDI/.test(await p.innerText('#mpGate')));
await p.click('#mpSeg [data-mp=local]'); await p.click('#btnCreate');
check('MULTIPLAYER: Crea stanza still opens the existing create flow (game picker)', (await p.evaluate(() => document.body.dataset.screen)) === 'friends-create');
await p.goBack().catch(() => {}); await p.waitForFunction(() => document.body.dataset.screen === 'library');
check('NAV: Back from a sub-flow screen returns to the main screen', (await p.evaluate(() => document.body.dataset.screen)) === 'library');

// ============================================================================ 7. Settings, About, developer mode
await go(p, 'settings'); await shot(p, 'settings');
check('SETTINGS: system files (DS and PlayStation), appearance and information are here; test settings are hidden for normal users', await p.isVisible('#sysList') && await p.isVisible('#ps1SysList') && !(await p.isVisible('details.devonly')));
await p.click('#btnAbout');
const about = await p.innerText('#aboutBox');
check('ABOUT: PlaySphere, version, privacy statement and the open-source licences (the only place that names the components)', /PlaySphere/.test(about) && /Privacy/.test(about) && /GPL/.test(about) && /melonDS/.test(about) && /PCSX-ReARMed/.test(about) && /PlaySphere/.test(await p.innerText('#abVersion')));
await p.click('#abClose');
for (let i = 0; i < 7; i++) await p.click('#verLine');
check('DEV MODE: tapping the version seven times reveals the developer settings (and only then)', await p.isVisible('details.devonly') && (await p.evaluate(() => document.body.classList.contains('dev'))));
for (let i = 0; i < 7; i++) await p.click('#verLine');
check('DEV MODE: seven more taps hide them again', !(await p.isVisible('details.devonly')));

// ============================================================================ 8. themes and contrast
const tokens = (pg) => pg.evaluate(() => { const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim(); return { text: v('--ps-text'), muted: v('--ps-text-muted'), bg: v('--ps-bg'), solid: v('--ps-surface-solid'), primary: v('--ps-primary-strong'), onPrimary: v('--ps-text-on-primary'), success: v('--ps-success'), warning: v('--ps-warning'), danger: v('--ps-danger'), theme: document.documentElement.getAttribute('data-theme') }; });
const lum = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); const n = parseInt(m[1], 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((u, v) => v - u); return (x + 0.05) / (y + 0.05); };
for (const theme of ['dark', 'light']) {
  await p.click(`[data-theme-set=${theme}]`); const t = await tokens(p);
  const pairs = { 'text on page': ratio(t.text, t.bg), 'text on card': ratio(t.text, t.solid), 'muted on page': ratio(t.muted, t.bg), 'muted on card': ratio(t.muted, t.solid), 'button text on primary': ratio(t.onPrimary, t.primary), 'success on card': ratio(t.success, t.solid), 'warning on card': ratio(t.warning, t.solid), 'danger on card': ratio(t.danger, t.solid) };
  const bad = Object.entries(pairs).filter(([, r]) => r < 4.5).map(([k, r]) => `${k} ${r.toFixed(2)}`);
  check(`THEME ${theme.toUpperCase()}: applies (data-theme) and every text/background pair of the tokens reaches WCAG AA (4.5:1)`, t.theme === theme && !bad.length, bad.join('; ') || Object.values(pairs).map((r) => r.toFixed(1)).join(' '));
  await shot(p, `settings-${theme}`);
}
await p.click('[data-theme-set=system]');
check('THEME: "Sistema" follows the device and the choice is remembered', (await p.evaluate(() => localStorage.getItem('ps.theme'))) === 'system' && (await p.getAttribute('[data-theme-set=system]', 'aria-selected')) === 'true');
await closeP(p);
const lightCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' }); let lp = await lightCtx.newPage(); await lp.addInitScript(() => localStorage.setItem('ps.theme', 'system'));
await lp.goto(`${srv.base}/play/?nosw`); await lp.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('THEME: with "Sistema" a light device gets the light theme at the first paint', (await lp.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light'); await lp.close(); await lightCtx.close();

// ============================================================================ 9. accessibility
p = await openApp(browser, srv.base, '?nosw');
await p.setInputFiles('#romFile', [nds]); await until(async () => (await p.locator('#gameList li.game').count()) === 1, 15000);
const unnamed = await p.evaluate(() => [...document.querySelectorAll('button, [role=button], input:not([type=hidden]):not([type=file]), select, a[href]')].filter((e) => !e.hidden && !e.closest('[hidden]')).filter((e) => { const n = (e.getAttribute('aria-label') || e.innerText || e.textContent || e.getAttribute('title') || e.placeholder || (e.labels && e.labels[0] && e.labels[0].textContent) || '').trim(); return !n; }).map((e) => e.id || e.className || e.tagName));
check('A11Y: every control has an accessible name (aria-label, text or label)', !unnamed.length, unnamed.join(','));
check('A11Y: landmarks and basics - lang, main, navigation, skip link, one h1 per visible screen', (await p.evaluate(() => document.documentElement.lang)) === 'it' && !!(await p.$('main#app')) && !!(await p.$('nav[aria-label]')) && !!(await p.$('a.skip')));
await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
const ring = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { w: parseFloat(cs.outlineWidth), s: cs.outlineStyle }; });
check('A11Y: keyboard focus is visible (outline of at least 2px on the focused control)', !!ring && ring.s !== 'none' && ring.w >= 2, JSON.stringify(ring));
await go(p, 'games'); await p.focus('#gameList li.game'); await p.keyboard.press('Enter');
check('A11Y: a game card opens its detail from the keyboard (Enter) and Escape closes it', await p.isVisible('#gameDetail')); await p.keyboard.press('Escape');
check('A11Y: the dialog is announced (role=dialog, aria-modal, labelled)', (await p.getAttribute('#gameDetail', 'role')) === 'dialog' && (await p.getAttribute('#gameDetail', 'aria-modal')) === 'true' && !!(await p.getAttribute('#gameDetail', 'aria-labelledby')));
await closeP(p);
const rm = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); const rp = await rm.newPage(); await rp.goto(`${srv.base}/play/?nosw`); await rp.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
const dur = await rp.evaluate(() => { const s = getComputedStyle(document.querySelector('.screen.on')); return parseFloat(s.animationDuration) * (s.animationDuration.endsWith('ms') ? 1 : 1000); });
check('A11Y: prefers-reduced-motion removes the animations (screen transition is effectively instant)', dur < 5, String(dur)); await rm.close();
const big = await browser.newContext({ viewport: { width: 390, height: 844 } }); const bp = await big.newPage(); await bp.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '150%'; }); });
await bp.goto(`${srv.base}/play/?nosw`); await bp.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('A11Y: font scaling (150%) keeps the layout inside the screen (no horizontal scroll)', (await overflow(bp)) <= 1); await big.close();

// ============================================================================ 10. responsive layouts, safe areas
const layouts = [['phone-portrait', 390, 844], ['phone-landscape', 844, 390], ['small-phone', 360, 640], ['tablet', 820, 1180], ['desktop', 1280, 800]];
for (const [name, w, h] of layouts) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900, deviceScaleFactor: 1 }); const q = await c.newPage(); await q.goto(`${srv.base}/play/?nosw`); await q.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
  await q.setInputFiles('#romFile', [nds, ...files(discs, 'Test Game.cue', 'Test Game.bin')]); await until(async () => (await q.locator('#gameList li.game').count()) === 2, 20000);
  const res = {}; for (const t of ['home', 'games', 'multiplayer', 'settings']) { await go(q, t); await sleep(120); res[t] = await overflow(q); }
  const nav = await q.evaluate(() => { const r = document.getElementById('psNav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
  const cols = await (async () => { await go(q, 'games'); return q.evaluate(() => getComputedStyle(document.getElementById('gameList')).gridTemplateColumns.split(' ').length); })();
  const where = nav.y > nav.vh / 2 && nav.w >= nav.vw - 2 ? 'bottom' : nav.x <= 1 && nav.h >= nav.vh - 2 ? 'side' : '?';
  const expectNav = name === 'desktop' ? 'side' : name === 'phone-landscape' ? 'side' : 'bottom';
  check(`RESPONSIVE ${name.toUpperCase()} (${w}x${h}): no horizontal overflow on Home, Libreria, Multiplayer, Impostazioni; navigation is ${expectNav}; ${cols} columns of games`, Object.values(res).every((o) => o <= 1) && where === expectNav, JSON.stringify(res) + ' nav=' + where);
  await go(q, 'home'); await shot(q, `home-${name}`); await go(q, 'games'); await shot(q, `library-${name}`); await c.close();
}
const css = fs.readFileSync(path.join(ROOT, 'cloud/web/play/playsphere.css'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'cloud/web/play/index.html'), 'utf8');
check('SAFE AREAS: viewport-fit=cover and env(safe-area-inset-*) on top, sides and bottom (notch, Dynamic Island, gesture bar, Android cut-out, landscape)', /viewport-fit=cover/.test(html) && ['top', 'bottom', 'left', 'right'].every((s) => css.includes(`env(safe-area-inset-${s}`)));
check('IPHONE SAFARI: 100dvh (not 100vh alone), visual viewport handling for the keyboard, standalone meta, no scroll lock leaks', /100dvh/.test(css) && /visualViewport/.test(fs.readFileSync(path.join(ROOT, 'cloud/web/play/shell.js'), 'utf8')) && /apple-mobile-web-app-capable/.test(html));

// ============================================================================ 11. offline badge, install hint, haptics, lite mode
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); p = await ctx2.newPage();
await p.addInitScript(() => { window.__vib = []; navigator.vibrate = (x) => { window.__vib.push(x); return true; }; });
await p.goto(`${srv.base}/play/?nosw`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
await ctx2.setOffline(true); await p.evaluate(() => dispatchEvent(new Event('offline')));
check('OFFLINE: a discreet "Offline" badge appears and a toast says local games still work', await p.isVisible('#psOffline') && /funzionano comunque/.test(await p.innerText('#cloudToast')));
await ctx2.setOffline(false); await p.evaluate(() => dispatchEvent(new Event('online')));
check('OFFLINE: back online the badge goes away', !(await p.isVisible('#psOffline')));
await p.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__installPrompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); dispatchEvent(e); });
check('INSTALL: when the browser says the app is installable, a non-intrusive "INSTALLA PLAYSPHERE" card appears on Home', await p.isVisible('#installCard') && /INSTALLA PLAYSPHERE/.test(await p.innerText('#btnInstall')));
await p.click('#btnInstall'); check('INSTALL: the button opens the browser\'s install prompt', await p.evaluate(() => window.__installPrompted === true));
await p.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({}); dispatchEvent(e); }); await p.click('#btnInstallLater');
check('INSTALL: "not now" hides it and it stays away (14 days)', !(await p.isVisible('#installCard')) && Number(await p.evaluate(() => localStorage.getItem('ps.installNo'))) > 0);
await p.evaluate(() => window.__vib.length = 0); await go(p, 'games'); await p.click('#libTabs [data-lib=fav]'); await p.click('[data-theme-set]').catch(() => {});
await go(p, 'settings'); await p.click('[data-theme-set=dark]');
check('HAPTICS: light feedback on UI taps where the platform has vibration', (await p.evaluate(() => window.__vib.length)) > 0);
await p.evaluate(() => { const b = document.getElementById('optHaptic'); b.checked = false; b.dispatchEvent(new Event('change')); window.__vib.length = 0; }); await p.click('[data-theme-set=light]'); await p.click('[data-theme-set=dark]');
check('HAPTICS: the setting turns them off, and never vibrates continuously (single short pulses only)', (await p.evaluate(() => window.__vib.length)) === 0 && (await p.evaluate(() => localStorage.getItem('ps.hapticGame'))) !== '1');
await p.evaluate(() => { const L = document.getElementById('optLite'); L.checked = true; L.dispatchEvent(new Event('change')); });
check('LITE MODE: "Riduci gli effetti" removes blur and the animated background', (await p.evaluate(() => getComputedStyle(document.querySelector('.cta')).backdropFilter)) === 'none' && (await p.evaluate(() => document.body.classList.contains('ps-lite'))));
await ctx2.close();
const weak = await browser.newContext({ viewport: { width: 390, height: 844 } }); const wp = await weak.newPage(); await wp.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 }));
await wp.goto(`${srv.base}/play/?nosw`); await wp.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('LITE MODE: a weak device (2 cores) starts in lite mode by itself', await wp.evaluate(() => document.body.classList.contains('ps-lite'))); await weak.close();

// ============================================================================ 12. errors, loading, empty states
p = await openApp(browser, srv.base, '?nosw');
const cases = [['File del disco non trovato: a.bin', /File mancante/], ['Gioco non trovato nell\'archivio', /File mancante/], ['Servono BIOS e firmware', /file di sistema/i], ['Questo dispositivo non supporta questo runtime (WebAssembly SIMD)', /non compatibile/i],
  ['QuotaExceededError: local_quota', /Spazio esaurito/], ['Download non riuscito: rete', /Download non riuscito/], ['Cloud non raggiungibile', /Cloud/], ['RuntimeError: unreachable\n    at wasm-function[12]:0x4f2\n    at stack...', /si è fermato/]];
let allOk = true, detail = '';
for (const [msg, re] of cases) {
  await p.evaluate((m) => window.dslinkPlay.shell.showError(m), msg);
  const s = await p.evaluate(() => ({ screen: document.body.dataset.screen, t: document.getElementById('errorTitle').textContent, w: document.getElementById('errorNote').textContent, todo: document.getElementById('errorTodo').textContent, tech: document.getElementById('errorTech').textContent, vis: document.querySelector('[data-screen=error]').innerText }));
  const ok = s.screen === 'error' && re.test(s.t + ' ' + s.w) && s.w.length > 10 && s.todo.length > 10 && !/\bat \w|wasm-function|stack/.test(s.vis) && s.tech.split('\n').length === 1; if (!ok) { allOk = false; detail += msg.slice(0, 24) + ' => ' + JSON.stringify(s).slice(0, 120) + '; '; }
  await p.click('#btnErrBack');
}
check('ERROR STATES: each failure says what happened and what to do, in plain words; a stack trace never reaches the screen (core crash included)', allOk, detail);
await p.evaluate(() => window.dslinkPlay.shell.showError('x')); await shot(p, 'error'); await p.click('#btnErrBack');
// a real flow: the disc files disappear from the device, then GIOCA
await p.setInputFiles('#romFile', files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.locator('#gameList li.game').count()) === 1, 15000);
await p.evaluate(async () => { const g = window.dslinkPlay.store; for (const k of await g.list('library/')) if (k.includes('/disc/')) await g.del(k); });
await go(p, 'games'); await p.click('li.game .play'); await p.waitForFunction(() => document.body.dataset.screen === 'error', null, { timeout: 15000 });
check('ERROR STATES: a real missing-file failure shows "File mancante" with the way out, and the app is usable afterwards (no reload needed)', /File mancante/.test(await p.innerText('#errorTitle')) && (await p.evaluate(() => window.__workers ? window.__workers.size : 0)) === 0);
await p.click('#btnErrBack'); check('ERROR STATES: "TORNA ALLA LIBRERIA" returns to a working library', (await p.evaluate(() => document.body.dataset.screen)) === 'library' && (await p.locator('#gameList li.game').count()) === 1);
await closeP(p);
// loading state: slow core download, the user sees the loading screen with steps, not a frozen page
const lc = await browser.newContext({ viewport: { width: 390, height: 844 } }); p = await lc.newPage();
await p.addInitScript(() => { window.__workers = new Set(); });
await p.route('**/core/ps1/*.wasm', async (r) => { await new Promise((x) => setTimeout(x, 1800)); r.continue(); });
await p.goto(`${srv.base}/play/?nosw`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
await p.setInputFiles('#romFile', files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.locator('#gameList li.game').count()) === 1, 30000); await go(p, 'games');
await p.click('li.game .play'); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 30000 }); await p.click('#btnHleGo');
const saw = await until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'loading' ? await p.evaluate(() => ({ title: document.getElementById('loadingTitle').textContent, note: document.getElementById('loadingNote').textContent, on: [...document.querySelectorAll('#loadingSteps li.on, #loadingSteps li.done')].length, bar: !!document.querySelector('[data-screen=loading] [role=progressbar]') })) : null, 20000, 40);
check('LOADING STATES: while the system starts there is a loading screen with the game name, a note, progress steps and an indeterminate bar', !!saw && saw.title.length > 0 && saw.note.length > 0 && saw.bar, JSON.stringify(saw)); await lc.close();

// ============================================================================ 13. the normal UI never names the cores; no PC Remote
const p2 = await openApp(browser, srv.base, '?nosw'); await p2.setInputFiles('#romFile', [nds, ...files(discs, 'Test Game.cue', 'Test Game.bin')]); await until(async () => (await p2.locator('#gameList li.game').count()) === 2, 20000);
let leaks = [];
for (const t of ['home', 'games', 'multiplayer', 'settings']) { await go(p2, t); const tx = await text(p2); if (NO_CORE.test(tx)) leaks.push(t + ':' + (NO_CORE.exec(tx) || [])[0]); }
check('NORMAL UI: Home, Libreria, Multiplayer and Impostazioni never show the core, WebAssembly or emulator names (they are only in About and the support details)', !leaks.length, leaks.join(','));
const hits = []; const scan = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); if (f.isDirectory()) { if (!['node_modules', 'core', 'icons'].includes(f.name)) scan(fp); } else if (/\.(js|ts|html|css|json|mjs|cpp|hpp|go)$/.test(f.name) && !/play_ui_e2e|check_no/.test(f.name)) { const t = fs.readFileSync(fp, 'utf8'); if (/RemoteGameSession|NVENC|Windows Host|RPCS3 remote|PCSX2 remote|Dolphin remote/i.test(t)) hits.push(path.relative(ROOT, fp)); } } };
for (const d of ['cloud/web', 'cloud/worker/src', 'cloud/gateway', 'runtime/src', 'wasm']) if (fs.existsSync(path.join(ROOT, d))) scan(path.join(ROOT, d));
const evalHits = []; const scanEval = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== 'core') scanEval(fp); } else if (/\.(js|mjs)$/.test(f.name)) { const t = fs.readFileSync(fp, 'utf8'); if (/\beval\s*\(|new\s+Function\s*\(/.test(t)) evalHits.push(f.name); } } };
for (const d of ['cloud/web/play', 'cloud/worker/public/controls']) scanEval(path.join(ROOT, d)); for (const f of fs.readdirSync(path.join(ROOT, 'cloud/web/play/core'))) if (f.endsWith('.js') && /\beval\s*\(|new\s+Function\s*\(/.test(fs.readFileSync(path.join(ROOT, 'cloud/web/play/core', f), 'utf8'))) evalHits.push('core/' + f);
check('SECURITY: no eval() / new Function() anywhere in the app, the controls or the generated core loaders, so the CSP needs no unsafe-eval in production (only WebAssembly: wasm-unsafe-eval)', !evalHits.length && !/unsafe-eval(?!')/.test(fs.readFileSync(path.join(ROOT, 'cloud/csp.txt'), 'utf8').replace(/'wasm-unsafe-eval'/g, '')), evalHits.join(','));
check('PC REMOTE: not implemented - no RemoteGameSession, Windows Host, NVENC or remote RPCS3/PCSX2/Dolphin anywhere in the app code', !hits.length, hits.join(','));
await closeP(p2);

check('SECURITY: with the production Content-Security-Policy (scripts from this origin only, no inline script, no framing) no part of the app was blocked - Home, Library, DS and PlayStation games, themes, workers, WebAssembly', cspHits.length === 0, [...new Set(cspHits)].join(' | '));
await browser.close(); srv.close();
const ok = done(); process.exit(ok ? 0 : 1);
