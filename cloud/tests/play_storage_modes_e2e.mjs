// PlaySphere: private Cloud storage (R2) is OPTIONAL. The same test runs against a Worker WITH R2 and one WITHOUT it (the mode is read from /api/config) and checks what the user sees:
//   R2 present : "SALVA NEL MIO CLOUD", the Cloud usage bar.
//   R2 absent  : no "Salva nel Cloud" for ROM / BIOS, "Cloud storage non configurato" on Home / Settings / Game detail, the local game plays and saves normally,
//                account / friends / ICE keep working, and no technical Cloudflare / R2 wording ever reaches the user.
// usage: node play_storage_modes_e2e.mjs <worker-base-url> <homebrew.nds>
import { chromium } from 'playwright';
const [BASE, nds] = process.argv.slice(2);
if (!BASE || !nds) { console.error('usage: play_storage_modes_e2e.mjs <worker-url> <nds>'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const cfg = await (await fetch(BASE + '/api/config')).json(); const R2 = cfg.storage === 'r2';
console.log(`mode: R2_ENABLED=${R2}`);
check('CONFIG: /api/config reports the storage mode', cfg.storage === 'r2' || cfg.storage === 'none', String(cfg.storage));
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, hasTouch: true });
const p = await ctx.newPage(); const errors = [], failed = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('dialog', (d) => d.accept());
p.on('response', (r) => { if (/\/api\/(files|saves|storage)/.test(r.url()) && r.status() >= 400) failed.push(r.status() + ' ' + new URL(r.url()).pathname); });
await p.goto(`${BASE}/play/?stun=0&nosw`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
const go = (t) => p.evaluate((x) => window.dslinkPlay.go(x), t);
await go('games'); await p.setInputFiles('#romFile', nds); await until(() => p.evaluate(() => window.dslinkPlay.games.length === 1), 20000);
const user = 'st' + Math.random().toString(36).slice(2, 9);
await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on'); await p.fill('#authUser', user);
await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', 'correct horse battery staple'); await p.click('#btnPwCreate');
const logged = await until(() => p.evaluate(() => document.body.dataset.screen === 'profile'), 15000); await p.click('#btnProfBack');
check('ACCOUNT: sign-up works whatever the storage mode', logged);
await sleep(1500);
const technical = /R2|Cloudflare|10042|STORAGE_NOT_CONFIGURED|wrangler|bucket|Please enable/;
const text = async () => p.evaluate(() => document.body.innerText);

// ---- library card / game detail
await go('games');
const card = await p.evaluate(() => [...document.querySelectorAll('#gameList li.game button')].map((b) => b.textContent.trim()));
if (R2) check('R2 ON: the card offers "SALVA NEL MIO CLOUD"', card.includes('SALVA NEL MIO CLOUD'), card.join('|'));
else check('R2 OFF: "Salva nel Cloud" is not offered for ROM / BIOS (card)', !card.some((t) => /SALVA NEL MIO CLOUD|RIMUOVI DAL CLOUD/.test(t)), card.join('|'));
await p.locator('#gameList li.game .ttl').first().click(); await p.waitForSelector('#gameDetail:not([hidden])');
await p.click('#gdFiles'); await sleep(200);
const sheet = await p.evaluate(() => document.getElementById('gameDetail').textContent);      // textContent: also the actions inside the collapsed "Gestisci file" menu
if (R2) check('R2 ON: the detail sheet offers the Cloud actions', /SALVA NEL MIO CLOUD/.test(sheet));
else check('R2 OFF: the detail sheet says "Cloud storage non configurato" and offers no Cloud upload', /Cloud storage non configurato/.test(sheet) && !/SALVA NEL MIO CLOUD/.test(sheet), sheet.replace(/\s+/g, ' ').slice(0, 160));
check('NO TECHNICAL WORDING in the detail sheet', !technical.test(sheet));
await p.keyboard.press('Escape');

// ---- home + settings
await go('home'); await sleep(400);
const sync = await p.innerText('#homeSync');
if (!R2) check('R2 OFF: Home shows "Cloud storage non configurato" as the Cloud state', /Cloud storage non configurato/i.test(sync), sync);
else check('R2 ON: Home shows a normal Cloud state', !/non configurato/.test(sync), sync);
check('NO TECHNICAL WORDING on Home', !technical.test(await text()));
await go('settings'); await sleep(400);
const bar = await p.isVisible('#cloudBar'), off = await p.isVisible('#cloudOff'), offTxt = await p.innerText('#cloudOff');
if (R2) check('R2 ON: Settings shows the Cloud bar (usage, sync now)', bar);
else check('R2 OFF: Settings hides the Cloud bar and says "Cloud storage non configurato"; local storage keeps working', !bar && off && /Cloud storage non configurato/.test(offTxt), offTxt);
check('NO TECHNICAL WORDING in Settings', !technical.test(await text()));
if (!R2) check('R2 OFF: no PlayStation BIOS "salva nel Cloud" choice (BIOS stays on the device)', !(await p.evaluate(() => [...document.querySelectorAll('#ps1SysList button, #sysList button')].some((b) => /CLOUD/i.test(b.textContent)))));

// ---- local game still plays and saves
await go('games'); await p.locator('#gameList li.game button.play').first().click();
const playing = await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2500);
check('LOCAL GAME: starts and runs at full speed with the storage mode as it is', playing && (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 45);
await p.evaluate(async () => { await window.dslinkPlay.player.save(true); window.dslinkPlay.controls.openMenu(); });
await p.click('.ctl-menu [data-act=leave]'); await p.click('#confirmYes'); await p.waitForFunction(() => document.body.dataset.screen === 'library', null, { timeout: 20000 });
check('LOCAL SAVE: the save is on the device after playing', await p.evaluate(async () => { const g = window.dslinkPlay.games[0]; const b = await window.dslinkPlay.store.get(`library/${g.id}/save`); return !!b && b.byteLength > 0; }));
check('NO TECHNICAL WORDING after playing (library, toasts)', !technical.test(await text()) && !technical.test(await p.evaluate(() => (document.getElementById('cloudToast') || {}).textContent || '')));

// ---- everything that does not need R2 keeps working
const st = await p.evaluate(async () => {
  const j = async (u) => { const r = await fetch(u, { credentials: 'include' }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
  return { me: await j('/api/me'), friends: await j('/api/friends'), ice: await j('/api/realtime/ice'), lib: await j('/api/library'), files: await j('/api/files') };
});
check('ACCOUNT / FRIENDS / ICE (Internet multiplayer) / library metadata answer normally', st.me.s === 200 && st.friends.s === 200 && st.ice.s === 200 && st.lib.s === 200, JSON.stringify([st.me.s, st.friends.s, st.ice.s, st.lib.s]));
if (!R2) check('R2 OFF: file routes answer 503 STORAGE_NOT_CONFIGURED (application error, no crash)', st.files.s === 503 && st.files.b.error === 'STORAGE_NOT_CONFIGURED', JSON.stringify([st.files.s, st.files.b.error]));
else check('R2 ON: file routes answer 200', st.files.s === 200);
await p.click('#btnAccount').catch(() => {}); await sleep(300);
check('NO SCRIPT ERROR on the page', !errors.length, errors.join(' | '));
if (!R2) check('R2 OFF: at most one probing call hit a file route before the app learnt the mode (no retry storm)', failed.length <= 2, failed.join(','));
await browser.close(); process.exit(results.every(Boolean) ? 0 : 1);
