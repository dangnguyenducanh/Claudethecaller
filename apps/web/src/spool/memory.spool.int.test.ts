/** Gate `memory.spool` (D15): web down -> spool files -> web up -> each event processed once; a corrupt file lands in corrupt/. Scratch Postgres and Redis only. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bullJobId, createQueues, type Queues } from '@ctc/shared/queues';
import { createDb, createRepositories, type Db, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { createSpoolDrain, nudgeRoute, type SpoolDrain } from './index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../../hooks/spool');
const pgUrl = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const redisUrl = process.env['CTC_SCRATCH_REDIS_URL'] ?? '';
const hostPort = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname}:${x.port}`;
  } catch {
    return 'unparsable';
  }
};
const fixture = (n: string) => fs.readFileSync(path.join(HERE, 'fixtures', `${n}.json`), 'utf8');
const rnd = () => randomBytes(4).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
};

const schema = `ctc_t41_${rnd()}`;
const namespace = `t41${rnd()}:`;
const userId = `gate-${rnd()}`;
const dirs: string[] = [];
let db: Db;
let repos: Repositories;
let queues: Queues;

beforeAll(async () => {
  expect(hostPort(pgUrl)).toBe('127.0.0.1:18304');
  expect(hostPort(redisUrl)).toBe('127.0.0.1:18395');
  await migrate({ url: pgUrl, schema });
  db = createDb({ url: pgUrl, schema });
  repos = createRepositories(db);
  queues = createQueues({ url: redisUrl, namespace });
}, 60_000);

afterAll(async () => {
  for (const q of ['graph', 'llm']) await queues?.get(q).obliterate({ force: true });
  await queues?.close();
  await db?.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  await db?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}, 60_000);

type Run = { code: number | null; stdout: string; stderr: string; ms: number };
/** The real hooks/spool under dash. */
const hook = (stdin: string, event: string, dir: string, nudge: string) =>
  new Promise<Run>((resolve) => {
    const t0 = Date.now();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t41-home-'));
    dirs.push(home);
    const p = spawn('dash', [SCRIPT, event], { env: { PATH: process.env['PATH'] ?? '', HOME: home, CTC_SPOOL_DIR: dir, CTC_NUDGE_URL: nudge } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.stderr.on('data', (b) => (stderr += b));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.on('error', () => undefined);
    p.stdin.end(stdin);
  });

const rows = async () => (await repos.jobs.list({ userId }, { limit: 100 })).rows;
const kinds = async () => (await rows()).map((r) => `${r.queue}.${r.kind}`).sort();

describe('memory.spool', () => {
  it('web down -> files -> web up -> each event processed once; a corrupt file lands in corrupt/', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t41-gate-'));
    dirs.push(dir);

    // 1. web down: the nudge goes to a closed loopback port
    const closedPort = await new Promise<number>((res) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => res(port));
      });
    });
    const down = `http://127.0.0.1:${closedPort}/v1/spool/nudge`;
    for (const [name, event] of [['post-edit', 'PostToolUse'], ['post-read', 'PostToolUse'], ['stop', 'Stop'], ['session-end', 'SessionEnd']] as const) {
      const r = await hook(fixture(name), event, dir, down);
      expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
      expect(r.ms).toBeLessThanOrEqual(500);
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(4);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'planted-Stop-1-00000001.json'), 'not json');

    // 2. web up
    const drain: SpoolDrain = createSpoolDrain({ dir, keepDays: 7, userId, queues, repos });
    const route = nudgeRoute(drain);
    const server = http.createServer((req, res) => {
      if (req.method === route.method && req.url === route.url) {
        route.handler(req, { code: (n) => ((res.statusCode = n), { send: () => res.end() }) });
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    try {
      expect(await drain.drainOnce()).toEqual({ queued: 3, dropped: 1, corrupt: 1, kept: 0, expired: 0 });
      await drain.start();
      expect(await kinds()).toEqual(['graph.rebuild', 'llm.extract', 'llm.summarize']);
      for (const r of await rows()) expect(await queues.get(r.queue).getJob(bullJobId(r.id))).toBeTruthy();
      const session = await repos.sessions.get({ userId }, '7f3c2d1e-9a4b-4c55-8e0a-1b2c3d4e5f60');
      expect(session?.endedAt).toBeInstanceOf(Date);
      expect(fs.readdirSync(dir)).toEqual(['corrupt']);
      expect(fs.readdirSync(path.join(dir, 'corrupt'))).toEqual(['planted-Stop-1-00000001.json']);

      // 3. once: another pass, a second drain on the same dir, and a re-placed copy of a delivered file
      expect(await drain.drainOnce()).toEqual({ queued: 0, dropped: 0, corrupt: 0, kept: 0, expired: 0 });
      const second = createSpoolDrain({ dir, keepDays: 7, userId, queues, repos });
      const stopRows = (await rows()).filter((r) => r.kind === 'extract');
      const stopId = stopRows[0]!.id.slice('spool:'.length);
      fs.writeFileSync(path.join(dir, `${stopId}.json`), JSON.stringify({ v: 1, event: 'Stop', received_at: '2026-10-31T09:15:02Z', payload: { session_id: '7f3c2d1e-9a4b-4c55-8e0a-1b2c3d4e5f60', cwd: '/work/demo' } }));
      expect(await second.drainOnce()).toEqual({ queued: 1, dropped: 0, corrupt: 0, kept: 0, expired: 0 });
      await second.close();
      expect(await kinds()).toEqual(['graph.rebuild', 'llm.extract', 'llm.summarize']);

      // 4. nudge: one more Stop through the script, delivered without calling drainOnce()
      const up = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/spool/nudge`;
      await hook(JSON.stringify({ session_id: 'nudge-session', cwd: '/work/demo', hook_event_name: 'Stop' }), 'Stop', dir, up);
      expect(await waitFor(async () => (await rows()).length === 4, 2000)).toBe(true);
    } finally {
      await drain.close();
      await new Promise<void>((res) => server.close(() => res()));
    }
  }, 60_000);
});
