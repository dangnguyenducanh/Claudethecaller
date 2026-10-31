/**
 * Gate `suggest.skills`: NDCG@10 of the skill channel on the SkillRet test split (6,006 skills, 4,392 queries) must be at least 0.80.
 * Needs the scratch Postgres 127.0.0.1:18304 (CTC_SCRATCH_PG_URL), the TEI embedder from config/models.yaml and `.ctc-dev/eval/skillret-test.json`
 * (`python3 agent/t3-3-skill-channel/selfcheck.py --export`, path overridable with CTC_SKILLRET_FILE). Skipped when a prerequisite is missing,
 * unless CTC_GATE_SUGGEST_SKILLS=1: then a missing prerequisite fails the test. Document vectors are cached on disk under `.ctc-dev/eval/`, never in Redis.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex, skillretText } from '@ctc/core/library';
import { ndcgAt, recallAt } from '@ctc/core/skills';
import { loadConfig } from '@ctc/shared/env';
import { createDb, createRepositories, type Db, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { createTei } from '@ctc/shared/tei';
import { afterAll, describe, expect, it } from 'vitest';
import { createSkillChannel } from './index.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const FILE = process.env['CTC_SKILLRET_FILE'] ?? path.join(ROOT, '.ctc-dev/eval/skillret-test.json');
const PG_URL = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const STRICT = process.env['CTC_GATE_SUGGEST_SKILLS'] === '1';
const ready = STRICT || (fs.existsSync(FILE) && PG_URL !== '');
const BAR = 0.8;
const USER = { userId: 'eval' };

type Data = {
  skills: { id: string; name: string; description: string; body: string }[];
  queries: { id: string; query: string }[];
  qrels: Record<string, Record<string, number>>;
};

/** Vectors on disk under `.ctc-dev/eval/vec-cache/`, one file per `emb:` key. */
function diskCache(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key: string): string => path.join(dir, `${key.replace(/[^a-z0-9]/gi, '-')}.f32`);
  return {
    async getVec(key: string): Promise<Float32Array | undefined> {
      try {
        const b = fs.readFileSync(file(key));
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      } catch {
        return undefined;
      }
    },
    async setVec(key: string, vec: ArrayLike<number>): Promise<void> {
      fs.writeFileSync(file(key), Buffer.from(Float32Array.from(vec).buffer));
    },
  };
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

let db: Db | undefined;
let schema: string | undefined;
afterAll(async () => {
  if (!db) return;
  try {
    if (schema) await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  } finally {
    await db.close();
  }
});

describe.skipIf(!ready)('suggest.skills', () => {
  it('SkillRet test split: NDCG@10 of the skill channel is at least 0.80', async () => {
    const missing: string[] = [];
    if (!fs.existsSync(FILE)) missing.push(`${FILE} (run: python3 agent/t3-3-skill-channel/selfcheck.py --export)`);
    if (PG_URL === '') missing.push('env CTC_SCRATCH_PG_URL');
    expect(missing, 'missing prerequisites').toEqual([]);
    const pu = new URL(PG_URL);
    if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') throw new Error(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);

    const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Data;
    const config = loadConfig({ dir: path.join(ROOT, 'config'), env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t33-home-')) });
    schema = `ctc_t33_${randomBytes(4).toString('hex')}`;
    await migrate({ url: PG_URL, schema });
    db = createDb({ url: PG_URL, schema, max: 8 });
    const repos: Repositories = createRepositories(db);
    const tei = createTei({ config, cache: diskCache(path.join(ROOT, '.ctc-dev/eval/vec-cache')) });

    const skillOfCap = new Map<string, string>();
    const BATCH = 32;
    for (let i = 0; i < data.skills.length; i += BATCH) {
      const chunk = data.skills.slice(i, i + BATCH);
      const texts = chunk.map((s) => skillretText(s, config.embed.skillret_body_chars));
      const vectors = await tei.embed(texts);
      await Promise.all(
        chunk.map(async (s, j) => {
          const { version } = await repos.library.createVersion(USER, {
            namespace: `sr-${s.id}`, kind: 'skill', name: s.name, description: s.description, rootPath: `skillret://${s.id}`, bodyHash: sha256Hex(s.body), blobs: [], files: [],
          });
          await repos.library.setServed(USER, version.capId, 1);
          await repos.library.upsertVector(USER, { capId: version.capId, textHash: sha256Hex(texts[j] as string), embedding: vectors[j] as number[], model: config.embed_model });
          skillOfCap.set(version.capId, s.id);
        }),
      );
    }

    const channel = createSkillChannel({ repos, tei, config });
    expect(await channel.reload(USER)).toEqual({ ok: true, size: data.skills.length });

    let ndcg = 0;
    let r5 = 0;
    let r10 = 0;
    const totals: number[] = [];
    for (const q of data.queries) {
      const res = await channel.search(USER, q.query, { k: 10 });
      expect(res.degraded, `query ${q.id}`).toEqual([]);
      const ranked = res.hits.map((h) => skillOfCap.get(h.capId) as string);
      const rel = data.qrels[q.id] ?? {};
      ndcg += ndcgAt(ranked, rel, 10);
      r5 += recallAt(ranked, rel, 5);
      r10 += recallAt(ranked, rel, 10);
      totals.push(res.ms.total);
    }
    const n = data.queries.length;
    totals.sort((a, b) => a - b);
    const result = { n, skills: data.skills.length, ndcg10: ndcg / n, recall5: r5 / n, recall10: r10 / n, p50_ms: percentile(totals, 0.5), p95_ms: percentile(totals, 0.95) };
    fs.writeFileSync(path.join(ROOT, '.ctc-dev/eval/suggest.skills.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(`suggest.skills ${JSON.stringify(result)}`);
    expect(result.ndcg10).toBeGreaterThanOrEqual(BAR);
  }, 3_600_000);
});

