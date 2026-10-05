// End-to-end of the PWA in a real (mobile-emulated) Chromium: passkey account, password account, friends + presence, private library upload,
// invite -> accept -> session -> WebRTC game screen fed by the DSLink Runtime. Worker = `wrangler dev` (real Worker/D1/R2/Durable Objects),
// container = a local gateway (the only substitution; see docs/CLOUD.md).
// usage: node pwa_e2e.mjs <worker-url> <rom.nds> [firmware.bin]
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:8787', romPath = process.argv[3];
const chrome = process.env.CHROME || undefined;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, step = 150) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return null; await sleep(step); } };

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'allow' };
const tag = Date.now().toString(36).slice(-5);
const nameA = 'simone' + tag, nameB = 'luca' + tag;

async function open(extra = {}) {
  const ctx = await browser.newContext({ ...mobile, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return { ctx, page };
}
const A = await open(), B = await open();
// virtual platform authenticator for A (passkeys, discoverable credential, user verified)
const cdp = await A.ctx.newCDPSession(A.page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

// ---------------------------------------------------------------- PWA basics
await A.page.goto(base);
check('login screen shows with passkey as the primary action', !!(await until(() => A.page.locator('#btnPasskey').isVisible())));
const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
check('web app manifest: standalone, icons 192+512, theme', manifest.display === 'standalone' && manifest.icons.some((i) => i.sizes === '512x512') && manifest.icons.some((i) => i.sizes === '192x192') && !!manifest.theme_color);
check('icons are real PNGs', (await Promise.all(manifest.icons.map(async (i) => (await fetch(base + i.src)).headers.get('content-type')))).every((t) => t === 'image/png'));
const swReady = await until(() => A.page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && (r.active || r.installing || r.waiting)); }), 15000);
check('service worker registered', !!swReady);
await A.page.evaluate(() => navigator.serviceWorker.ready);
const cachedPrivate = await A.page.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
check('service worker caches the app shell only (no /api, no private data)', cachedPrivate.length > 3 && cachedPrivate.every((p) => !p.startsWith('/api/') && !p.startsWith('/internal/')), cachedPrivate.join(','));
check('viewport meta + apple touch icon for iOS home-screen install', !!(await A.page.locator('meta[name=viewport][content*=viewport-fit]').count()) && !!(await A.page.locator('link[rel=apple-touch-icon]').count()));
check('no horizontal scroll on a 390px phone', await A.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

// ---------------------------------------------------------------- account A: passkey
await A.page.click('#tabRegister');
await A.page.fill('#username', nameA);
await A.page.fill('#displayName', 'Simone');
await A.page.click('#btnPasskey');
check('account A created with a passkey (no password)', !!(await until(() => A.page.locator('#meName').isVisible())) && (await A.page.textContent('#meName')) === 'Simone');
const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
check('the authenticator holds one discoverable (resident) credential for dslink', creds.length === 1 && creds[0].isResidentCredential && creds[0].rpId === 'localhost');
await A.page.click('#btnSettings'); await A.page.getByText('Esci', { exact: true }).click();
check('logout returns to the login screen', !!(await until(() => A.page.locator('#btnPasskey').isVisible())));
await A.page.click('#btnPasskey');   // discoverable credential: no username typed
check('passkey login without typing a username', !!(await until(() => A.page.locator('#meName').isVisible())));

// ---------------------------------------------------------------- account B: password
await B.page.goto(base);
await B.page.click('#tabRegister'); await B.page.click('#togglePw');
await B.page.fill('#username', nameB); await B.page.fill('#displayName', 'Luca'); await B.page.fill('#password', 'una password molto lunga 123');
await B.page.click('#btnPassword');
check('account B created with a password', !!(await until(() => B.page.locator('#meName').isVisible())) && (await B.page.textContent('#meName')) === 'Luca');

// ---------------------------------------------------------------- friends + presence
await A.page.fill('#friendName', nameB); await A.page.click('#btnAddFriend');
check('B receives the friend request live and accepts', !!(await until(() => B.page.locator('[data-req]').isVisible())));
await B.page.locator('[data-req] button.ok').click();
const cardB = () => A.page.locator('[data-friend]').filter({ hasText: 'Luca' });
check('A sees B as a friend, ONLINE (B has the app open)', !!(await until(async () => (await cardB().textContent())?.includes('Online'))));
// presence on browser close: a third context opens/closes
const C = await open();
await C.page.goto(base);
await C.page.click('#tabRegister'); await C.page.click('#togglePw');
const nameC = 'anna' + tag;
await C.page.fill('#username', nameC); await C.page.fill('#password', 'una password molto lunga 123'); await C.page.click('#btnPassword');
await until(() => C.page.locator('#meName').isVisible());
await A.page.fill('#friendName', nameC); await A.page.click('#btnAddFriend');
await until(() => C.page.locator('[data-req]').isVisible()); await C.page.locator('[data-req] button.ok').click();
const cardC = () => A.page.locator('[data-friend]').filter({ hasText: nameC });
check('A sees C ONLINE', !!(await until(async () => (await cardC().textContent())?.includes('Online'))));
await C.ctx.close();
check('closing the browser turns C OFFLINE for A (no "online forever")', !!(await until(async () => (await cardC().textContent())?.includes('Offline'), 15000)));
check('INVITA is disabled for an offline friend', await cardC().locator('button.primary').isDisabled());

// ---------------------------------------------------------------- private library: add game from the device
const [chooser] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.click('#btnAddGame')]);
await chooser.setFiles(romPath);
check('game appears in I TUOI GIOCHI after the upload, platform detected (Nintendo DS)', !!(await until(async () => { const t = await A.page.locator('[data-game]').first().textContent().catch(() => ''); return t.includes('DSLINKTEST1') && t.includes('Nintendo DS'); }, 20000)));
const junk = '/tmp/pwa_junk.nds'; fs.writeFileSync(junk, Buffer.alloc(4096, 7));
const [chooser2] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.click('#btnAddGame')]);
await chooser2.setFiles(junk);
await sleep(1500);
check('a file that is not a DS ROM is refused', (await A.page.locator('[data-game]').count()) === 1);
// B has no games and no firmware: nothing of A's library is visible
check("B's library is empty (A's game is private)", (await B.page.locator('[data-game]').count()) === 0);

// ---------------------------------------------------------------- invite -> accept -> session -> game screen
await cardB().locator('button.primary').click();
await A.page.locator('.modal button.card').first().click();
const txt = await until(async () => B.page.locator('#inviteText').textContent(), 15000);
check('B gets the invite: "<A> ti invita a giocare a <gioco>" with ACCETTA / RIFIUTA', txt === 'Simone ti invita a giocare a DSLINKTEST1' && (await B.page.locator('#btnAccept').isVisible()) && (await B.page.locator('#btnRefuse').isVisible()), txt);
await B.page.click('#btnAccept');
const gameA = await until(() => A.page.locator('#game video').isVisible(), 90000), gameB = await until(() => B.page.locator('#game video').isVisible(), 90000);
check('both players enter the game screen', !!gameA && !!gameB);
const slots = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.dslinkGame?.info.slot)));
check('Player 1 = inviter (has the cartridge), Player 2 = invitee', slots[0] === 1 && slots[1] === 2, slots.join(','));
const playing = async (p) => until(() => p.page.evaluate(() => { const v = document.querySelector('#game video'); return v && v.videoWidth > 0 && !v.paused; }), 60000);
check('video from the DSLink Runtime reaches both browsers via WebRTC', !!(await playing(A)) && !!(await playing(B)));
const px = (p) => p.page.evaluate(() => { const v = document.querySelector('#game video'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d'); x.drawImage(v, 0, 0); return [...x.getImageData(c.width / 2 | 0, 6, 1, 1).data.slice(0, 3)]; });
const pa = await until(async () => { const v = await px(A); return v[2] > 60 && v[0] < 40 ? v : null; }, 20000);
check("Player 1 sees its game (test ROM 1: blue)", !!pa, JSON.stringify(pa));
const [ra, rb] = [await px(A), await px(B)];
check("Player 2's picture is a different framebuffer (no cartridge)", Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2]) > 60, JSON.stringify([ra, rb]));
const friendsOf = async (p) => p.page.evaluate(async () => (await window.__dslink.api('GET', '/api/friends')).friends);
const inGame = await until(async () => { const f = (await friendsOf(A)).find((x) => x.displayName === 'Luca'); return f && f.status === 'IN_GAME'; }, 20000);
check('friends see the players as IN_GAME while the session lives (A sees B IN_GAME)', !!inGame);
const redAt = (p) => p.page.evaluate(() => { const v = document.querySelector('#game video'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d'); x.drawImage(v, 0, 0); return [...x.getImageData(428, 148, 1, 1).data.slice(0, 3)]; });
await A.page.evaluate(() => window.dslinkGame.btn('a', true));
const red = await until(async () => { const v = await redAt(A); return v[0] > 200 && v[1] < 120 ? v : null; }, 8000);
await A.page.evaluate(() => window.dslinkGame.btn('a', false));
check('the on-screen/keyboard button path (PWA game screen) reaches the Runtime: A pressed -> emulator 1 reacts', !!red, JSON.stringify(red));
await A.page.screenshot({ path: '/tmp/pwa_A_game.png' }); await B.page.screenshot({ path: '/tmp/pwa_B_game.png' });
// leaving: A exits -> B's heartbeat sees the session ended and B is released too
const ctlInfo = await A.page.evaluate(() => ({ n: document.querySelectorAll('#game .ctl-c').length, o: window.dslinkGame?.controls?.layout?.orientation, plat: window.dslinkGame?.controls?.layout?.platform }));
check('game screen mounts the DS touch controls in the portrait layout (L R D-pad ABXY MENU SELECT START)', ctlInfo.n === 7 && ctlInfo.o === 'portrait' && ctlInfo.plat === 'nds', JSON.stringify(ctlInfo));
const mb = await A.page.locator('#game [data-id=menu] .ctl-pillbtn').boundingBox();
await A.page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
check('MENU in the game screen opens the in-game menu', !!(await until(() => A.page.locator('#game .ctl-menu').isVisible(), 5000)));
await A.page.locator('#game .ctl-menu button[data-act=leave]').click();
check('A leaves; the session ends and B is brought back to the home screen', !!(await until(() => B.page.locator('#meName').isVisible(), 40000)));
check('A is back on the home screen', !!(await until(() => A.page.locator('#meName').isVisible())));
check('both are ONLINE again (the IN_GAME lease is released)', !!(await until(async () => (await cardB().textContent())?.includes('Online'), 15000)));

// ---------------------------------------------------------------- offline shell + deletion
await A.ctx.setOffline(true);
await A.page.reload().catch(() => {});
check('the app shell loads offline from the service worker cache', !!(await until(() => A.page.locator('#app').count(), 8000)) && (await A.page.title()) === 'DSLink');
await A.ctx.setOffline(false);
await B.page.click('#btnSettings');
B.page.on('dialog', (d) => d.accept(nameB));
await B.page.click('#btnDeleteAccount');
check('account deletion removes B; A no longer lists B', !!(await until(async () => { await A.page.reload(); await sleep(600); return (await A.page.locator('[data-friend]').filter({ hasText: 'Luca' }).count()) === 0; }, 15000)));

await browser.close();
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
