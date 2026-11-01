import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './admin/index.ts';
import { createSystemCtx } from './ctx.ts';
import { createDb, type Db } from './db.ts';
import { createRepositories, type Repositories } from './index.ts';
import { scratchUrl } from './scratch.ts';

const schema = `ctc_t63_${randomBytes(4).toString('hex')}`;
let db: Db;
let repos: Repositories;
const sctx = createSystemCtx('system-runner test');

beforeAll(async () => {
  const url = scratchUrl();
  await migrate({ url, schema });
  db = createDb({ url, schema });
  repos = createRepositories(db);
}, 60_000);
afterAll(async () => {
  try {
    await db?.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  } finally {
    await db?.close();
  }
});

describe('repos.system.runner.listActiveRuns (D24)', () => {
  it('lists queued, running, waiting and quota runs of every user in id order and no finished run', async () => {
    const mk = (userId: string, status: string) => repos.runner.createRun({ userId }, { owner: `o-${randomBytes(3).toString('hex')}`, trigger: 'api', status });
    const active = [await mk('u-a', 'running'), await mk('u-b', 'waiting'), await mk('u-a', 'queued'), await mk('u-b', 'quota')];
    const finished = [await mk('u-a', 'done'), await mk('u-b', 'failed'), await mk('u-a', 'cancelled')];
    const list = await repos.system.runner.listActiveRuns(sctx);
    const ids = list.map((r) => r.id);
    for (const r of active) expect(ids).toContain(r.id);
    for (const r of finished) expect(ids).not.toContain(r.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(list.find((r) => r.id === active[1]?.id)?.userId).toBe('u-b');
  });

  it('refuses a plain ctx', async () => {
    await expect(repos.system.runner.listActiveRuns({ userId: 'u-a' } as never)).rejects.toThrow(TypeError);
  });
});
