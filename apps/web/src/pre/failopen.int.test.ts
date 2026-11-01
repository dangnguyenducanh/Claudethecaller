/**
 * Gate `failopen` (spec:369, D21): with TEI, Redis or Postgres down (refused and hanging endpoints), the prompt hook (T5.1) still replies within 140 ms and the
 * pre hook (T5.2) within 40 ms, plus 25 ms of slack for scheduler jitter. Real clients (`createTei`, `createCache`, `createDb` + `createRepositories`,
 * `createGraphStore`, `createSkillChannel`) are pointed at dead loopback endpoints; the handlers `suggestRoutes(deps)[0]` and `preRoutes(deps)[0]` are
 * called in process, 5 timed calls per scenario and hook. Setup (a scratch schema `ctc_t52_<random>` holding a small ledger graph, the warm-up calls) is
 * outside the timing. Always runs: a missing scratch service or TEI fails the test with that reason. Writes `.ctc-dev/eval/failopen.json`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCache } from '@ctc/shared/cache';
import { loadConfig } from '@ctc/shared/env';
import { createDb, createRepositories, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { createTei } from '@ctc/shared/tei';
import { afterAll, describe, expect, it } from 'vitest';
import { createGraphStore } from '../graph/index.ts';
import { createSkillChannel } from '../skills/index.ts';
import { suggestRoutes, type SuggestDeps } from '../suggest/index.ts';
import { EVAL, reply, ROOT } from '../suggest/testing.ts';
import { preRoutes } from './index.ts';
import { bounded, deadPorts, READ, ROOTDIR, scratchPgUrl, scratchRedisUrl, writeLedgerGraph } from './testing.ts';

type Dep = 'tei' | 'redis' | 'postgres';
type Kind = 'refused' | 'hang';
type Graph = 'warm' | 'cold';
type Row = { down: Dep[]; kind: Kind; graph: Graph; hook: 'prompt' | 'pre'; n: number; max_ms: number; budget_ms: number; codes: number[]; texts: number };

const SLACK_MS = 25;
const BUDGET = { prompt: 140, pre: 40 };
const N = 5;
const USER = { userId: 'local' };
const KINDS: Kind[] = ['refused', 'hang'];
const rows: Row[] = [];
const closers: (() => Promise<void>)[] = [];

const writeResults = (): void => {
  fs.mkdirSync(EVAL, { recursive: true });
  fs.writeFileSync(path.join(EVAL, 'failopen.json'), `${JSON.stringify({ slack_ms: SLACK_MS, scenarios: rows, recorded_at: new Date().toISOString() }, null, 1)}\n`);
};
afterAll(async () => {
  for (const c of closers.reverse()) await bounded(c, 8000);
}, 180_000);

type Base = { config: ReturnType<typeof loadConfig>; repos: Repositories; dead: Record<Kind, Repositories>; ports: { refused: number; hang: number }; redisUrl: string };
let ready: Promise<Base> | undefined;
const prepared = (): Promise<Base> => (ready ??= setup());

async function setup(): Promise<Base> {
  const url = scratchPgUrl();
  const redisUrl = scratchRedisUrl();
  const config = loadConfig({ dir: path.join(ROOT, 'config'), env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t52-home-')) });
  await createTei({ config }).embed(['ping']).catch((e: unknown) => {
    throw new Error(`TEI embedder 127.0.0.1:18300 is not reachable: ${String(e)}`);
  });
  const probe = createCache({ url: redisUrl, namespace: `ctc_t52_${randomBytes(4).toString('hex')}:` });
  closers.push(() => probe.close());
  await probe.set('probe', 1, 5);
  if (!probe.up) throw new Error('scratch Redis 127.0.0.1:18395 is not reachable');
  const schema = `ctc_t52_${randomBytes(4).toString('hex')}`;
  await migrate({ url, schema }).catch((e: unknown) => {
    throw new Error(`scratch Postgres 127.0.0.1:18304 is not reachable: ${String(e)}`);
  });
  const db = createDb({ url, schema, max: 4 });
  closers.push(async () => {
    try {
      await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
    } finally {
      await db.close();
    }
  });
  const repos = createRepositories(db);
  const project = await repos.projects.upsert(USER, { root: ROOTDIR });
  await writeLedgerGraph(repos, { ...USER, projectId: project.id });
  const ports = await deadPorts(closers);
  const deadRepos = (port: number): Repositories => {
    const d = createDb({ url: `postgresql://postgres:ctcdev@127.0.0.1:${port}/postgres`, schema, max: 2 });
    closers.push(() => d.close());
    return createRepositories(d);
  };
  return { config, repos, dead: { refused: deadRepos(ports.refused), hang: deadRepos(ports.hang) }, ports, redisUrl };
}

type Handler = { handler(req: { body: unknown }, rep: ReturnType<typeof reply>): Promise<unknown> };
async function timed(route: Handler, body: unknown): Promise<{ ms: number; code: number; text: string }> {
  const rep = reply();
  const t0 = performance.now();
  await route.handler({ body }, rep);
  const ms = performance.now() - t0;
  const b = rep.b as { hookSpecificOutput?: { additionalContext?: string } } | string | undefined;
  return { ms, code: rep.c ?? 0, text: typeof b === 'string' ? b : (b?.hookSpecificOutput?.additionalContext ?? '') };
}

/** One scenario: fresh clients, store and skill channel; the dead dependencies point at `kind` endpoints; `warm` loads graph and project first. */
async function scenario(down: Dep[], kind: Kind, graph: Graph): Promise<void> {
  const { config, repos: live, dead, ports, redisUrl } = await prepared();
  const swap = { current: live };
  const facade = new Proxy({} as Repositories, { get: (_t, p) => Reflect.get(swap.current, p) });
  const cold = graph === 'cold';
  const repos = down.includes('postgres') && cold ? dead[kind] : facade;
  const cache = createCache({ url: down.includes('redis') ? `redis://127.0.0.1:${ports[kind]}` : redisUrl, namespace: `ctc_t52_${randomBytes(4).toString('hex')}:` });
  const teiUrl = down.includes('tei') ? `http://127.0.0.1:${ports[kind]}` : undefined;
  const tei = createTei({ config: teiUrl ? { ...config, embed_url: teiUrl, rerank_url: teiUrl } : config, cache });
  const store = createGraphStore({ repos, cache });
  const skills = createSkillChannel({ repos, tei, config, cache });
  const prompt = suggestRoutes({ repos, tei, config, graph: store, skills, cache } as unknown as SuggestDeps)[0] as Handler;
  const pre = preRoutes({ repos, config, graph: store, cache })[0] as Handler;
  const readBody = { ...READ(), session_id: 'gate' };
  const promptBody = (i: number) => ({ prompt: `how does postEntry post the ledger entry, variant ${i} ${randomBytes(3).toString('hex')}`, cwd: ROOTDIR });
  try {
    if (!cold) {
      await timed(pre, readBody);
      await timed(prompt, promptBody(-1));
      if (down.includes('postgres')) swap.current = dead[kind];
    }
    for (const hook of ['prompt', 'pre'] as const) {
      const got: Awaited<ReturnType<typeof timed>>[] = [];
      for (let i = 0; i < N; i++) got.push(await timed(hook === 'pre' ? pre : prompt, hook === 'pre' ? readBody : promptBody(i)));
      const row: Row = {
        down: [...down], kind, graph, hook, n: N, max_ms: Math.round(Math.max(...got.map((g) => g.ms)) * 10) / 10, budget_ms: BUDGET[hook],
        codes: got.map((g) => g.code), texts: got.filter((g) => g.code === 200).length,
      };
      rows.push(row);
      const label = `${down.join('+')} ${kind} ${graph} ${hook}`;
      console.log(`failopen ${label} max ${row.max_ms} ms codes ${row.codes.join(',')}`);
      expect(got.every((g) => g.code === 200 || g.code === 204), `${label}: codes ${row.codes}`).toBe(true);
      expect(row.max_ms, `${label} max_ms`).toBeLessThanOrEqual(BUDGET[hook] + SLACK_MS);
      const content = !cold && down.length === 1 && (hook === 'pre' || down[0] === 'tei');
      if (content) {
        expect(row.texts, `${label}: replies with text`).toBe(N);
        expect(got.every((g) => g.text.startsWith('ctc: ')), `${label}: text ${got[0]?.text}`).toBe(true);
      }
    }
  } finally {
    writeResults();
    await bounded(() => cache.close(), 8000);
  }
}

describe('failopen', () => {
  it('TEI down (refused and hanging): the prompt hook replies within 140 ms with the lexical line and the pre hook within 40 ms with the note', async () => {
    for (const kind of KINDS) await scenario(['tei'], kind, 'warm');
  }, 600_000);

  it('Redis down (refused and hanging): the prompt hook replies within 140 ms and the pre hook within 40 ms with the note', async () => {
    for (const kind of KINDS) await scenario(['redis'], kind, 'warm');
  }, 600_000);

  it('Postgres down (refused and hanging): both hooks reply within their budgets, from the warm RAM graph or empty when it is cold', async () => {
    for (const kind of KINDS) {
      await scenario(['postgres'], kind, 'warm');
      await scenario(['postgres'], kind, 'cold');
    }
  }, 600_000);

  it('TEI, Redis and Postgres all down: both hooks reply within their budgets and never fail', async () => {
    for (const kind of KINDS) await scenario(['tei', 'redis', 'postgres'], kind, 'cold');
  }, 600_000);
});
