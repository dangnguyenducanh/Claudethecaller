import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@ctc/shared/env';
import { createDb, type Db } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import type { Handler } from '../jobs/index.ts';
import { composeWorker, HANDLER_KEYS, mergeHandlers, type Worker } from './compose.ts';

const PG = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const REDIS = process.env['CTC_SCRATCH_REDIS_URL'] ?? 'redis://127.0.0.1:18395';
const schema = `ctc_t71_${randomBytes(4).toString('hex')}`;
const namespace = `t71k${randomBytes(4).toString('hex')}:`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-'));
let db: Db;
let worker: Worker;

beforeAll(async () => {
  await migrate({ url: PG, schema });
  db = createDb({ url: PG, schema });
  const config = loadConfig({ home, env: { CTC_DATABASE_URL: PG, CTC_REDIS_URL: `${REDIS}/0`, CTC_PORT: '18411' } });
  worker = composeWorker({ config, db, namespace, runsDir: path.join(home, 'runs'), dev: true, log: () => undefined });
}, 60_000);
afterAll(async () => {
  await worker?.close();
  const redis = new Redis(`${REDIS}/0`, { maxRetriesPerRequest: 1 });
  const [, keys] = await redis.scan('0', 'MATCH', `${namespace}*`, 'COUNT', 10_000);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
  await db?.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  await db?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('switch.worker', () => {
  it('registers exactly the 12 handler keys', () => {
    expect(Object.keys(worker.handlers).sort()).toEqual([...HANDLER_KEYS]);
    expect(HANDLER_KEYS).toHaveLength(12);
    expect(Object.keys(worker.handlers)).not.toContain('llm.enrich');
    expect(Object.values(worker.handlers).every((h) => typeof h === 'function')).toBe(true);
  });

  it('refuses a handler key that two modules both define, naming the key', () => {
    const h: Handler = async () => undefined;
    expect(() => mergeHandlers({ 'a.b': h }, { 'a.c': h }, { 'a.b': h })).toThrow('duplicate handler key a.b');
    expect(Object.keys(mergeHandlers({ 'a.b': h }, { 'a.c': h }))).toEqual(['a.b', 'a.c']);
  });

  it('reads and settles job rows through the system port, and points the runner at this process', async () => {
    expect(await worker.port.listQueued(5)).toEqual([]);
    expect(await worker.port.markRunning('no-such-job')).toBe(false);
    expect(worker.engine.reportBase).toBe('http://127.0.0.1:18411');
    expect(worker.engine.runsDir).toBe(path.join(home, 'runs'));
  });
});
