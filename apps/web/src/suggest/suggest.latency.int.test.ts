/**
 * Gate `suggest.latency` (spec:367, D21): over 100 SkillRet test prompts, the cold p95 of `POST /v1/suggest` (handler of `suggestRoutes`, built on `createSuggest`, called in process) is at most 150 ms
 * and the p95 of the second pass, served from the `sug:` cache (L1), is at most 10 ms. Setup outside the timing: a scratch schema `ctc_t51_<random>`, the
 * n8n-parity snapshot graph built by the real pipeline, the 6,006 SkillRet test skills embedded through the on-disk vector cache `.ctc-dev/eval/vec-cache/`,
 * a real `createCache` on the scratch Redis (CTC_SCRATCH_REDIS_URL) in a private namespace, the real TEI embedder. Runs only with CTC_GATE_SUGGEST=1 (then a
 * missing prerequisite fails). Needs `.ctc-dev/eval/skillret-test.json` (`python3 agent/t5-1-suggest/selfcheck.py --export`). Writes `.ctc-dev/eval/suggest.latency.json`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGrammars } from '@ctc/core/graph';
import { sha256Hex, skillretText } from '@ctc/core/library';
import { createCache } from '@ctc/shared/cache';
import { loadConfig } from '@ctc/shared/env';
import { createDb, createRepositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { createTei } from '@ctc/shared/tei';
import { afterAll, describe, expect, it } from 'vitest';
import { contextPass } from '../../../worker/src/context/index.ts';
import { rebuildProject } from '../../../worker/src/graph/index.ts';
import { createGraphStore } from '../graph/index.ts';
import { createSkillChannel } from '../skills/index.ts';
import { suggestRoutes, type SuggestDeps } from './index.ts';
import { diskCache, EVAL, extractSnapshot, percentile, reply, ROOT, scratchPgUrl, scratchRedisUrl } from './testing.ts';

const STRICT = process.env['CTC_GATE_SUGGEST'] === '1';
const FILE = process.env['CTC_SKILLRET_FILE'] ?? path.join(ROOT, '.ctc-dev/eval/skillret-test.json');
const COLD_P95_MS = 150;
const HIT_P95_MS = 10;
const N = 100;
const USER = { userId: 'eval' };

type Data = { skills: { id: string; name: string; description: string; body: string }[]; queries: { id: string; query: string }[] };
type Timings = { cold: number[]; hit: number[]; statuses: number[]; setup?: { graphNodes: number; skills: number } };
const state: Timings = { cold: [], hit: [], statuses: [] };

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => undefined);
}, 120_000);

/** Seeded sample (mulberry32, seed 0) of `n` distinct non-blank queries of `data`, sorted by id; `extra` more are returned for warm-up. */
function sample(data: Data, n: number, extra: number): { picked: string[]; warm: string[] } {
  let a = 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seen = new Set<string>();
  const pool = [...data.queries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).filter((q) => {
    const t = q.query.trim();
    if (t === '' || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as (typeof pool)[number], pool[i] as (typeof pool)[number]];
  }
  return { picked: pool.slice(0, n).map((q) => q.query), warm: pool.slice(n, n + extra).map((q) => q.query) };
}

const setup = async (): Promise<{ routes: ReturnType<typeof suggestRoutes>; prompts: string[]; warm: string[]; root: string }> => {
  expect(fs.existsSync(FILE), `missing ${FILE} (run: python3 agent/t5-1-suggest/selfcheck.py --export)`).toBe(true);
  const url = scratchPgUrl();
  const redisUrl = scratchRedisUrl();
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Data;
  const config = loadConfig({ dir: path.join(ROOT, 'config'), env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t51-home-')) });
  const teiDisk = createTei({ config, cache: diskCache(path.join(EVAL, 'vec-cache')) });
  await teiDisk.embed(['ping']).catch((e: unknown) => {
    throw new Error(`TEI embedder 127.0.0.1:18300 is not reachable: ${String(e)}`);
  });
  const embed = (texts: string[]): Promise<number[][]> => teiDisk.embed(texts);

  const schema = `ctc_t51_${randomBytes(4).toString('hex')}`;
  await migrate({ url, schema }).catch((e: unknown) => {
    throw new Error(`scratch Postgres 127.0.0.1:18304 is not reachable: ${String(e)}`);
  });
  const db = createDb({ url, schema, max: 8 });
  closers.push(async () => {
    try {
      await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
    } finally {
      await db.close();
    }
  });
  const repos = createRepositories(db);

  const root = extractSnapshot();
  const project = await repos.projects.upsert(USER, { root });
  const ctx = { ...USER, projectId: project.id };
  await rebuildProject({ repos, ctx, root, config, grammars: await loadGrammars(), embed });
  await contextPass({ repos, ctx, root, embed });

  const BATCH = 32;
  for (let i = 0; i < data.skills.length; i += BATCH) {
    const chunk = data.skills.slice(i, i + BATCH);
    const texts = chunk.map((s) => skillretText(s, config.embed.skillret_body_chars));
    const vectors = await teiDisk.embed(texts);
    await Promise.all(
      chunk.map(async (s, j) => {
        const { version } = await repos.library.createVersion(USER, {
          namespace: `sr-${s.id}`, kind: 'skill', name: s.name, description: s.description, rootPath: `skillret://${s.id}`, bodyHash: sha256Hex(s.body), blobs: [], files: [],
        });
        await repos.library.setServed(USER, version.capId, 1);
        await repos.library.upsertVector(USER, { capId: version.capId, textHash: sha256Hex(texts[j] as string), embedding: vectors[j] as number[], model: config.embed_model });
      }),
    );
  }

  const cache = createCache({ url: redisUrl, namespace: `ctc_t51_${randomBytes(4).toString('hex')}:` });
  closers.push(() => cache.close());
  const tei = createTei({ config, cache });
  const store = createGraphStore({ repos, embed, cache });
  const channel = createSkillChannel({ repos, tei, config, cache });
  const { index } = await store.get(ctx);
  expect(await channel.reload(USER)).toEqual({ ok: true, size: data.skills.length });
  state.setup = { graphNodes: index.nodes.size, skills: data.skills.length };
  const deps = { repos, tei, config, graph: store, skills: channel, cache } as unknown as SuggestDeps;
  const { picked, warm } = sample(data, N, 3);
  expect(picked).toHaveLength(N);
  return { routes: suggestRoutes(deps), prompts: picked, warm, root };
};

let ready: Promise<Awaited<ReturnType<typeof setup>>> | undefined;
const prepared = (): Promise<Awaited<ReturnType<typeof setup>>> => (ready ??= setup());

async function timed(routes: ReturnType<typeof suggestRoutes>, prompt: string, cwd: string): Promise<{ ms: number; status: number }> {
  const rep = reply();
  const t0 = performance.now();
  await (routes[1] as NonNullable<(typeof routes)[number]>).handler({ body: { prompt, cwd } }, rep);
  return { ms: performance.now() - t0, status: rep.c ?? 0 };
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: s.at(-1) ?? 0 };
};

describe.skipIf(!STRICT)('suggest.latency', () => {
  it('cold p95 of /v1/suggest over 100 SkillRet prompts is at most 150 ms', async () => {
    const { routes, prompts, warm, root } = await prepared();
    for (const w of warm) await timed(routes, w, root);
    for (const p of prompts) {
      const r = await timed(routes, p, root);
      state.cold.push(r.ms);
      state.statuses.push(r.status);
    }
    await new Promise((res) => setTimeout(res, 500));
    expect(state.statuses.every((s) => s === 200), `statuses ${JSON.stringify(state.statuses.filter((s) => s !== 200))}`).toBe(true);
    const cold = stat(state.cold);
    console.log(`suggest.latency cold ${JSON.stringify(cold)}`);
    expect(cold.p95).toBeLessThanOrEqual(COLD_P95_MS);
  }, 3_600_000);

  it('L1 hit p95 of /v1/suggest over the same prompts is at most 10 ms', async () => {
    const { routes, prompts, root } = await prepared();
    expect(state.cold, 'the cold pass must run first').toHaveLength(N);
    const statuses: number[] = [];
    for (const p of prompts) {
      const r = await timed(routes, p, root);
      state.hit.push(r.ms);
      statuses.push(r.status);
    }
    const cold = stat(state.cold);
    const hit = stat(state.hit);
    const result = { n: N, cold, hit, graph_nodes: state.setup?.graphNodes ?? 0, skills: state.setup?.skills ?? 0, load_1m: os.loadavg()[0] ?? 0, recorded_at: new Date().toISOString() };
    fs.mkdirSync(EVAL, { recursive: true });
    fs.writeFileSync(path.join(EVAL, 'suggest.latency.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(`suggest.latency ${JSON.stringify(result)}`);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(hit.p95).toBeLessThanOrEqual(HIT_P95_MS);
  }, 3_600_000);
});
