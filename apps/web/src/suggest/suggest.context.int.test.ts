/**
 * Gate `suggest.context` (spec:368, D22): the tree of commit a8ad531efdc4aebfd61d98f499ffe0a8dbaf68cb (the last `(n8n parity ...)` commit that still holds
 * the ticket files) is extracted with `git archive`, its graph is built by the real pipeline (`rebuildProject`, `contextPass`) in a scratch schema with the real
 * TEI embedder, and each ticket title is run through `createSuggest(...).run`. A ticket is a HIT when a file changed by its `(n8n parity NN)` commits equals
 * one of the first 3 distinct `candidates.file` entries. Runs only with CTC_GATE_SUGGEST=1 (then a missing prerequisite fails). Needs the scratch Postgres
 * 127.0.0.1:18304 and TEI 127.0.0.1:18300. Writes `.ctc-dev/eval/suggest.context.json`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGrammars } from '@ctc/core/graph';
import { loadConfig } from '@ctc/shared/env';
import { createDb, createRepositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { createTei } from '@ctc/shared/tei';
import { afterAll, describe, expect, it } from 'vitest';
import { contextPass } from '../../../worker/src/context/index.ts';
import { rebuildProject } from '../../../worker/src/graph/index.ts';
import { createGraphStore } from '../graph/index.ts';
import { createSuggest, type SuggestDeps } from './index.ts';
import { diskCache, EVAL, extractSnapshot, ROOT, scratchPgUrl, ticketTitle } from './testing.ts';

const SNAPSHOT = 'a8ad531efdc4aebfd61d98f499ffe0a8dbaf68cb';
const STRICT = process.env['CTC_GATE_SUGGEST'] === '1';
const BAR = 0.75;
const TEST_IDS = ['09', '10', '11', '12', '13', '14', '15', '16'];
const DEV_IDS = ['01', '02', '03', '04', '05', '06', '07', '08'];

let closeDb: (() => Promise<void>) | undefined;
afterAll(async () => {
  await closeDb?.();
}, 60_000);

/** Files changed by the non-merge commits whose subject ends with `(n8n parity NN)`, by ticket number. */
function truthByTicket(): Map<string, Set<string>> {
  const log = execFileSync('git', ['log', '--exclude=refs/stash', '--all', '--no-merges', '--name-only', '--format=%x00%s'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = new Map<string, Set<string>>();
  for (const chunk of log.split('\0').slice(1)) {
    const [subject, ...files] = chunk.split('\n');
    const m = /\(n8n parity (\d{2})\)$/.exec(subject ?? '');
    if (!m) continue;
    const set = out.get(m[1] as string) ?? new Set<string>();
    for (const f of files) if (f !== '') set.add(f);
    out.set(m[1] as string, set);
  }
  return out;
}

describe.skipIf(!STRICT)('suggest.context', () => {
  it('n8n-parity test tickets 09-16: file recall@3 of the suggest candidates is at least the m6 number 0.750', async () => {
    const url = scratchPgUrl();
    const config = loadConfig({ dir: path.join(ROOT, 'config'), env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t51-home-')) });
    const tei = createTei({ config, cache: diskCache(path.join(EVAL, 'vec-cache')) });
    await tei.embed(['ping']).catch((e: unknown) => {
      throw new Error(`TEI embedder 127.0.0.1:18300 is not reachable: ${String(e)}`);
    });
    const embed = (texts: string[]): Promise<number[][]> => tei.embed(texts);

    const root = extractSnapshot(SNAPSHOT);
    const schema = `ctc_t51_${randomBytes(4).toString('hex')}`;
    await migrate({ url, schema }).catch((e: unknown) => {
      throw new Error(`scratch Postgres 127.0.0.1:18304 is not reachable: ${String(e)}`);
    });
    const db = createDb({ url, schema });
    closeDb = async () => {
      try {
        await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
      } finally {
        await db.close();
      }
    };
    const repos = createRepositories(db);
    const project = await repos.projects.upsert({ userId: 'local' }, { root });
    const ctx = { userId: 'local', projectId: project.id };
    await rebuildProject({ repos, ctx, root, config, grammars: await loadGrammars(), embed });
    await contextPass({ repos, ctx, root, embed });
    const store = createGraphStore({ repos, embed });
    const { index } = await store.get(ctx);
    const codeFiles = new Set([...index.nodes.values()].filter((n) => n.kind === 'code' && n.sourceFile !== null).map((n) => n.sourceFile as string));

    const emptyChannel = { search: async () => ({ hits: [], degraded: [], ms: { load: 0, embed: 0, rank: 0, rerank: 0, total: 0 } }) };
    const suggest = createSuggest({ repos, tei, config, graph: store, skills: emptyChannel } as unknown as SuggestDeps);

    const truthAll = truthByTicket();
    const issues = path.join(root, '.scratch/n8n-parity/issues');
    const rows: { id: string; split: 'dev' | 'test'; truth: string[]; top3: string[]; hit: boolean; line: string }[] = [];
    const dropped: string[] = [];
    const line1: Record<'dev' | 'test', number> = { dev: 0, test: 0 };
    for (const id of [...DEV_IDS, ...TEST_IDS]) {
      const split = DEV_IDS.includes(id) ? 'dev' : 'test';
      const truth = [...(truthAll.get(id) ?? [])]
        .filter((f) => codeFiles.has(f) && !/^(tests|specs|\.scratch)\//.test(f) && !path.basename(f).startsWith('test_'))
        .sort();
      const issueFile = fs.readdirSync(issues).find((f) => f.startsWith(`${id}-`));
      const title = issueFile ? ticketTitle(fs.readFileSync(path.join(issues, issueFile), 'utf8')) : null;
      if (truth.length === 0 || !title) {
        dropped.push(id);
        continue;
      }
      const res = await suggest.run({ userId: 'local' }, { prompt: title.title, cwd: root });
      expect(res.degraded, `ticket ${id}`).toEqual([]);
      const top3 = res.candidates.file.slice(0, 3).map((c) => c.file as string);
      const hit = top3.some((f) => truth.includes(f));
      if (top3[0] !== undefined && truth.includes(top3[0])) line1[split]++;
      rows.push({ id, split, truth, top3, hit, line: res.line });
    }
    const part = (split: 'dev' | 'test') => {
      const r = rows.filter((x) => x.split === split);
      const hits = r.filter((x) => x.hit).length;
      return { tickets: r.length, hits, recall: r.length === 0 ? 0 : hits / r.length };
    };
    const test = part('test');
    const dev = part('dev');
    const at1 = (split: 'dev' | 'test'): number => (rows.filter((x) => x.split === split).length === 0 ? 0 : line1[split] / rows.filter((x) => x.split === split).length);
    const result = {
      snapshot: SNAPSHOT, test, dev, line_at1: { test: at1('test'), dev: at1('dev') }, dropped,
      per_ticket: rows.map(({ id, split, truth, top3, hit }) => ({ id, split, truth, top3, hit })), graph_nodes: index.nodes.size, recorded_at: new Date().toISOString(),
    };
    fs.mkdirSync(EVAL, { recursive: true });
    fs.writeFileSync(path.join(EVAL, 'suggest.context.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(`suggest.context test ${test.hits}/${test.tickets} dev ${dev.hits}/${dev.tickets} at1 ${JSON.stringify(result.line_at1)} dropped ${dropped.join(',')}`);
    expect(test.tickets).toBeGreaterThanOrEqual(6);
    expect(test.recall).toBeGreaterThanOrEqual(BAR);
  }, 3_600_000);
});
