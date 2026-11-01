import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '@ctc/shared/repositories/admin';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/worker/src/boot/main.ts');
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
  const redis = new Redis(REDIS, { maxRetriesPerRequest: 1 });
  for (const n of namespaces) {
    const [, keys] = await redis.scan('0', 'MATCH', `${n}*`, 'COUNT', 10_000);
    if (keys.length > 0) await redis.del(...keys);
  }
  redis.disconnect();
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
describe('ctc-worker start refusals (D6, D7, D12)', () => {
  const base = () => ({ home: mk(), port: 18425, schema: `ctc_t71_${rnd()}` });

  it('exits 78 for a port outside 18400-18499, another database or Redis, shared mode and a missing database url, without printing a password', async () => {
    expect(await refused(env({ ...base(), port: 18310 }))).toMatch(/port 18310/);
    expect(await refused(env({ ...base(), extra: { CTC_DATABASE_URL: 'postgresql://u:secretpw@10.255.255.1:5432/x' } }))).not.toContain('secretpw');
    expect(await refused(env({ ...base(), extra: { CTC_REDIS_URL: 'redis://:secretpw@127.0.0.1:18303/0' } }))).not.toContain('secretpw');
    expect(await refused(env({ ...base(), extra: { CTC_MODE: 'shared' } }))).toMatch(/shared mode/);
    expect(await refused(env({ ...base(), schema: 'Bad;Schema' }))).toMatch(/CTC_DB_SCHEMA/);
    const noDb = env(base());
    delete noDb['CTC_DATABASE_URL'];
    expect(await refused(noDb)).toContain('database_url is not set');
    expect(fs.readdirSync(EMPTY_HOME)).toEqual([]);
  }, 90_000);
});

describe('ctc-worker run (D16)', () => {
  it('prints the 12 handler keys, creates no spool or socket, and stops with exit 0 on SIGTERM within 15 s', async () => {
    const schema = `ctc_t71_${rnd()}`;
    schemas.push(schema);
    await migrate({ url: PG, schema });
    const home = mk();
    const o = start(env({ home, port: 18426, schema }));
    const line = await ready(o);
    expect(line['app']).toBe('ctc-worker');
    expect([...(line['handlers'] as string[])].sort()).toEqual([
      'cleanup.blobs', 'cleanup.receipts', 'cleanup.worktree', 'graph.extract', 'graph.rebuild', 'library.changed', 'library.scan', 'llm.extract', 'llm.summarize',
      'memory.distill', 'memory.import', 'runner.step',
    ]);
    const t0 = Date.now();
    o.p.kill('SIGTERM');
    expect(await o.exit).toEqual({ code: 0 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(fs.existsSync(path.join(home, '.claudethecaller/ctc.sock'))).toBe(false);
    expect(o.out).not.toContain('ctcdev');
  }, 90_000);
});
