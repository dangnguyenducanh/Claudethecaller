import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BindError, bind, listenLimits, listenPort, listenSocket, type Listener } from './listen.ts';

const saved = { ...listenLimits };
const open: Listener[] = [];
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(listenLimits, saved);
  await Promise.all(open.splice(0).map((l) => l.close()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-'));
  dirs.push(d);
  return d;
};
const ok: http.RequestListener = (_req, res) => void res.end('ok');
const freePort = (): Promise<number> => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

describe('bind (D8)', () => {
  it('pins the defaults: retry every second for up to 60 s, socket paths up to 100 bytes', () => {
    expect(saved).toEqual({ retryEveryMs: 1000, giveUpMs: 60_000, socketMaxBytes: 100 });
  });

  it('retries a taken port and succeeds once it is free', async () => {
    listenLimits.retryEveryMs = 20;
    const port = await freePort();
    const blocker = http.createServer(ok).listen(port, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const server = http.createServer(ok);
    setTimeout(() => blocker.close(), 80);
    await bind(server, { host: '127.0.0.1', port });
    open.push({ close: () => new Promise((r) => server.close(() => r())) });
    expect(server.listening).toBe(true);
  });

  it('gives up with a BindError after giveUpMs', async () => {
    listenLimits.retryEveryMs = 10;
    listenLimits.giveUpMs = 60;
    const port = await freePort();
    const blocker = http.createServer(ok).listen(port, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    await expect(bind(http.createServer(ok), { host: '127.0.0.1', port })).rejects.toBeInstanceOf(BindError);
    blocker.close();
  });

  it('serves on the loopback port', async () => {
    const port = await freePort();
    open.push(await listenPort(ok, port));
    const body = await new Promise<string>((res) => http.get({ host: '127.0.0.1', port }, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => res(s)); }));
    expect(body).toBe('ok');
  });
});

describe('listenSocket (D8)', () => {
  it('creates the socket with mode 0600 and removes it at close', async () => {
    const file = path.join(tmp(), 'ctc.sock');
    const l = await listenSocket(ok, file);
    expect(l).not.toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await l?.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes a stale socket file that nobody answers on', async () => {
    const file = path.join(tmp(), 'ctc.sock');
    const dead = net.createServer().listen(file);
    await new Promise((r) => dead.once('listening', r));
    dead.close();
    fs.writeFileSync(file, '');
    const l = await listenSocket(ok, file);
    expect(l).not.toBeNull();
    open.push(l as Listener);
  });

  it('skips a path of 101 bytes, binds one of 100', async () => {
    const dir = tmp();
    const logs: string[] = [];
    const name = (n: number): string => path.join(dir, 'a'.repeat(n - dir.length - 1));
    expect(await listenSocket(ok, name(101), (m) => logs.push(m))).toBeNull();
    expect(logs).toEqual(['socket skipped']);
    const fit = await listenSocket(ok, name(100));
    expect(fit).not.toBeNull();
    open.push(fit as Listener);
  });
});
