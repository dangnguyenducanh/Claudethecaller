import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@ctc/shared/repositories/admin';
import { deleteNamespace } from './redis-clean.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/web/src/server/main.ts');
const PG = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const REDIS = 'redis://127.0.0.1:18395/0';
const rnd = (): string => randomBytes(4).toString('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const schemas: string[] = [];
const namespaces: string[] = [];
const procs = new Set<ReturnType<typeof spawn>>();
const mk = (prefix = 'ctc-t71-'): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const EMPTY_HOME = mk();
afterAll(async () => {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  const { createDb } = await import('@ctc/shared/repositories');
  const db = createDb({ url: PG });
  for (const s of schemas) await db.kysely.schema.dropSchema(s).ifExists().cascade().execute();
  await db.close();
  for (const n of namespaces) await deleteNamespace(REDIS, n);
});

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CTC_') && k !== 'HOME')) as Record<string, string>;
function env(o: { home: string; port: number; schema: string; extra?: Record<string, string> }): Record<string, string> {
  const namespace = `t71m${rnd()}:`;
  namespaces.push(namespace);
  return { ...baseEnv, HOME: EMPTY_HOME, CTC_HOME: o.home, CTC_PORT: String(o.port), CTC_DATABASE_URL: PG, CTC_REDIS_URL: REDIS, CTC_DB_SCHEMA: o.schema, CTC_REDIS_NAMESPACE: namespace, ...o.extra };
}
function start(e: Record<string, string>) {
  const p = spawn(process.execPath, [MAIN], { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const o = { p, out: '', lines: [] as Record<string, unknown>[], exit: new Promise<{ code: number | null }>((res) => p.on('exit', (code) => res({ code }))) };
  let buf = '';
  p.stdout.on('data', (d: Buffer) => {
    o.out += d;
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      try { o.lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>); } catch { /* not json */ }
      buf = buf.slice(i + 1);
    }
  });
  p.stderr.on('data', (d: Buffer) => (o.out += d));
  return o;
}
async function refused(e: Record<string, string>, ms = 30_000): Promise<string> {
  const o = start(e);
  const r = await Promise.race([o.exit, sleep(ms).then(() => 'timeout' as const)]);
  if (r === 'timeout') o.p.kill('SIGKILL');
  expect(r).toEqual({ code: 78 });
  expect(o.lines.some((l) => l['msg'] === 'ready')).toBe(false);
  return o.out;
}
async function ready(o: ReturnType<typeof start>): Promise<Record<string, unknown>> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const hit = o.lines.find((l) => l['msg'] === 'ready');
    if (hit) return hit;
    if (o.p.exitCode !== null) throw new Error(`exited ${o.p.exitCode}: ${o.out.slice(-400)}`);
    await sleep(50);
  }
  throw new Error('not ready');
}
const get = (port: number, url: string, method = 'GET', body?: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: body ? { 'content-type': 'application/json' } : {}, timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('ctc-web start refusals (D6, D7, D12, D15)', () => {
  const base = () => ({ home: mk(), port: 18420, schema: `ctc_t71_${rnd()}` });

  it('exits 78 for a port outside 18400-18499, naming the port', async () => {
    expect(await refused(env({ ...base(), port: 18310 }))).toMatch(/port 18310/);
    await refused(env({ ...base(), port: 18303 }));
  }, 90_000);

  it('exits 78 for another database or Redis and never prints the password', async () => {
    expect(await refused(env({ ...base(), extra: { CTC_DATABASE_URL: 'postgresql://u:secretpw@10.255.255.1:5432/x' } }))).not.toContain('secretpw');
    expect(await refused(env({ ...base(), extra: { CTC_REDIS_URL: 'redis://:secretpw@127.0.0.1:18303/0' } }))).not.toContain('secretpw');
    expect(fs.readdirSync(EMPTY_HOME)).toEqual([]);
  }, 90_000);

  it('exits 78 for a bad config key, a bad schema name, a missing database url and shared mode', async () => {
    const cfg = mk();
    fs.cpSync(path.join(ROOT, 'config'), cfg, { recursive: true });
    fs.appendFileSync(path.join(cfg, 'server.yaml'), '\nbogus_key_t71: 1\n');
    expect(await refused(env({ ...base(), extra: { CTC_CONFIG_DIR: cfg } }))).toContain('bogus_key_t71');
    expect(await refused(env({ ...base(), schema: 'Bad;Schema' }))).toMatch(/CTC_DB_SCHEMA/);
    const noDb = env(base());
    delete noDb['CTC_DATABASE_URL'];
    expect(await refused(noDb)).toContain('database_url is not set');
    expect(await refused(env({ ...base(), extra: { CTC_MODE: 'shared' } }))).toMatch(/shared mode/);
  }, 90_000);

  it('exits 78 saying "ctc migrate" when the schema is behind the binary, and never migrates it', async () => {
    const old = mk();
    for (const m of loadMigrations().slice(0, 5)) fs.copyFileSync(path.join(ROOT, 'packages/shared/migrations', m.file), path.join(old, m.file));
    const schema = `ctc_t71_${rnd()}`;
    schemas.push(schema);
    await migrate({ url: PG, schema, dir: old });
    expect(await refused(env({ ...base(), schema }), 60_000)).toContain('ctc migrate');
    const { schemaVersion } = await import('@ctc/shared/repositories/admin');
    expect(await schemaVersion({ url: PG, schema })).toBe(5);
  }, 90_000);
});

describe('ctc-web run (D8, D13, D15)', () => {
  it('starts with a database that does not exist: health says db down, hooks answer 204, /api answers 500 internal; SIGTERM stops it cleanly', async () => {
    const home = mk();
    const o = start(env({ home, port: 18421, schema: `ctc_t71_${rnd()}`, extra: { CTC_DATABASE_URL: PG.replace(/\/[^/]*$/, '/ctc_t71_no_such_db') } }));
    const line = await ready(o);
    expect(line['app']).toBe('ctc-web');
    expect(line['port']).toBe(18421);
    expect(JSON.parse((await get(18421, '/v1/health')).text)).toMatchObject({ status: 'ok', mode: 'local', db: 'down' });
    expect((await get(18421, '/v1/hook/prompt', 'POST', '{"prompt":"x","cwd":"/tmp"}')).status).toBe(204);
    const api = await get(18421, '/api/runs');
    expect([api.status, JSON.parse(api.text).error.code]).toEqual([500, 'internal']);
    const sock = path.join(home, '.claudethecaller/ctc.sock');
    expect(fs.existsSync(sock)).toBe(true);
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    const t0 = Date.now();
    o.p.kill('SIGTERM');
    expect(await o.exit).toEqual({ code: 0 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(fs.existsSync(sock)).toBe(false);
    await expect(get(18421, '/v1/health')).rejects.toThrow();
    for (const l of o.lines) expect(typeof l['msg']).toBe('string');
    expect(o.out).not.toContain('ctcdev');
  }, 90_000);
});
