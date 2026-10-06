// Test harness for the multiplayer UX: two gateways = two DEVICES on one machine (own work dir, own library, own UDP discovery port).
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

export const P = {
  gateway: process.env.DSLINK_GATEWAY || '/tmp/dslink-gateway',
  runtime: process.env.DSLINK_RUNTIME || '/tmp/rt2/dslink-runtime',
  core: process.env.DSLINK_CORE || '/tmp/core-linux/build/src/libretro/melondsds_libretro.so',
  cfgtool: process.env.DSLINK_CFGTOOL || '/tmp/dslink-build/dslink_cfgtool',
  romcheck: process.env.DSLINK_ROMCHECK || '/tmp/dslink-build/dslink_romcheck',
  web: process.env.DSLINK_WEB || new URL('../web', import.meta.url).pathname,
  controls: process.env.DSLINK_CONTROLS || new URL('../worker/public/controls', import.meta.url).pathname,
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** opts: {name, port, udp, peerUdp, impair, firmware, testGuestRom, refs, extraEnv} */
export function startDevice(o) {
  const dir = `/tmp/mpdev_${o.name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, DSLINK_BACKEND: 'runtime', DSLINK_VIDEO_CODEC: 'vp8', DSLINK_RUNTIME: P.runtime, DSLINK_CORE: P.core, DSLINK_CFGTOOL: P.cfgtool, DSLINK_ROMCHECK: P.romcheck,
    DSLINK_WORKDIR: dir, DSLINK_LIBRARY: `${dir}/library`, DSLINK_LOOPBACK: '1', DSLINK_ADVERTISE_IP: '127.0.0.1', DSLINK_DEVICE_NAME: o.deviceName || `Telefono ${o.name}`,
    DSLINK_MP_PORT: String(o.udp), DSLINK_MP_DISCOVERY_ADDR: `127.0.0.1:${o.peerUdp}`, DSLINK_NETCHECK_IMPAIR: o.impair || '', ...(o.extraEnv || {}) };
  if (o.firmware) env.DSLINK_FIRMWARE_DIR = o.firmware;
  if (o.testGuestRom) env.DSLINK_TEST_GUEST_ROM = o.testGuestRom;
  if (o.refs) env.DSLINK_PROFILE_REFS = o.refs;
  const log = fs.openSync(`${dir}.log`, 'w');
  const p = spawn(P.gateway, ['-addr', `:${o.port}`, '-web', P.web, '-controls', P.controls], { env, stdio: ['ignore', log, log], detached: true });
  return { name: o.name, port: o.port, base: `http://localhost:${o.port}`, pid: p.pid, dir, proc: p,
    async ready() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${o.port}/api/mp/state`)).ok) return; } catch { /* starting */ } await sleep(100); } throw new Error('gateway did not start'); },
    async state(dev = false) { return (await fetch(`http://localhost:${o.port}/api/mp/state${dev ? '?dev=1' : ''}`)).json(); },
    stop() { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } },
    kill9() { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } },
    pause() { try { process.kill(p.pid, 'SIGSTOP'); } catch { /* gone */ } }, resume() { try { process.kill(p.pid, 'SIGCONT'); } catch { /* gone */ } } };
}

export const runtimeCount = () => { try { return Number(execSync('pgrep -x dslink-runtime | wc -l').toString().trim()); } catch { return 0; } };
export const runtimePids = () => { try { return execSync('pgrep -x dslink-runtime').toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
export async function waitState(dev, pred, ms = 30000, step = 250) { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await dev.state(); if (pred(s)) return s; await sleep(step); } return s; }

export const runtimePidsFor = (devName) => { try { return runtimePids().filter((p) => fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(`/tmp/mpdev_${devName}/`)); } catch { return []; } };
