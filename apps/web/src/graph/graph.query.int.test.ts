/**
 * Gate `graph.query` (spec:366, D22): the graph of THIS repository is built by the real extract, resolve and context pipeline in a scratch
 * schema with the real TEI embedder, and the 30 recorded Python answers are compared with what the core functions answer. Needs the scratch
 * Postgres 127.0.0.1:18304 and TEI 127.0.0.1:18300; if either is down the test fails with that reason (it never skips).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadGrammars } from '@ctc/core/graph';
import { affectedBy, findPath, neighborsOf, resolveName, searchGraph, QueryError } from '@ctc/core/graph/query';
import { createEmbedder } from '@ctc/shared/models';
import { createDb, createRepositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { contextPass } from '../../../worker/src/context/index.ts';
import { rebuildProject } from '../../../worker/src/graph/index.ts';
import { createGraphStore } from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CODE = ['file', 'module', 'class', 'function', 'method', 'interface', 'type', 'variable', 'package'];
const CONTEXT = ['spec', 'requirement', 'task', 'decision', 'page', 'heading'];

type Row = {
  id: string;
  tool: string;
  args: Record<string, string | number>;
  is_error: boolean;
  text: string;
  structured: Record<string, unknown>;
};

function scratchUrl(): string {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? 'postgresql://postgres:ctcdev@127.0.0.1:18304/postgres';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  return url;
}

const url = scratchUrl();
const schema = `ctc_t24_${randomBytes(4).toString('hex')}`;
const db = createDb({ url, schema });
afterAll(async () => {
  try {
    await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  } finally {
    await db.close();
  }
}, 60_000);

describe('graph.query', () => {
  it('30 fixed questions on this repo: top seed and affected set match the baseline in at least 27 of 30', async () => {
    const embed = createEmbedder({ url: 'http://127.0.0.1:18300', timeoutMs: 60_000 });
    await embed(['ping']).catch((e: unknown) => {
      throw new Error(`TEI embedder 127.0.0.1:18300 is not reachable: ${String(e)}`);
    });
    await migrate({ url, schema }).catch((e: unknown) => {
      throw new Error(`scratch Postgres 127.0.0.1:18304 is not reachable: ${String(e)}`);
    });
    const repos = createRepositories(db);
    const project = await repos.projects.upsert({ userId: 'local' }, { root: ROOT });
    const ctx = { userId: 'local', projectId: project.id };
    const grammars = await loadGrammars();
    const config = { mode: 'local', graph: { languages: ['ts', 'tsx', 'js', 'python', 'bash', 'sql', 'json', 'markdown'], shrink_guard: 0.2, debounce_s: 3 } };
    await rebuildProject({ repos, ctx, root: ROOT, config, grammars, embed });
    await contextPass({ repos, ctx, root: ROOT, embed });
    const { index } = await createGraphStore({ repos, embed }).get(ctx);
    const files = new Set([...index.nodes.values()].map((n) => n.sourceFile).filter((f): f is string => f !== null));

    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/py-baseline/graph-answers.json'), 'utf8')) as Row[];
    expect(baseline).toHaveLength(30);
    let score = 0;
    let vacuous = 0;
    const failing: string[] = [];
    for (const row of baseline) {
      let pass = false;
      try {
        if (row.is_error) {
          const want = row.tool === 'graph_affected' && row.text.includes('matches 2 nodes') ? 'ambiguous' : 'not_found';
          try {
            if (row.tool === 'graph_path') findPath(index, String(row.args['a']), String(row.args['b']), { directed: false });
            else affectedBy(index, String(row.args['node']), { depth: 3 });
          } catch (e) {
            pass = e instanceof QueryError && e.code === want;
          }
        } else if (row.tool === 'graph_search') {
          const types = row.args['graph'] === 'coding' ? CODE : row.args['graph'] === 'context' ? CONTEXT : undefined;
          const question = String(row.args['question']);
          const [queryVector] = await embed([question]);
          const found = searchGraph(index, { query: question, ...(types ? { types } : {}), limit: Math.max(Number(row.args['k']), 10), ...(queryVector ? { queryVector } : {}) });
          const hits = (row.structured['hits'] as { id: string; file?: string }[]).filter((h) => index.nodes.has(h.id) || (h.file && files.has(h.file)));
          if (hits.length === 0) {
            vacuous++;
            pass = true;
          } else pass = hits.slice(0, 3).some((h) => found.hits.some((x) => x.id === h.id || (h.file && x.file === h.file)));
        } else if (row.tool === 'graph_explain') {
          const node = resolveName(index, String(row.args['node']));
          const want = (row.structured['neighbours'] as { id: string; type: string }[]).filter((x) => x.type === 'code');
          const have = new Set(neighborsOf(index, String(row.args['node']), { limit: 200 }).neighbors.map((x) => x.node.id));
          pass = node.id === (row.structured['node'] as { id: string }).id && (want.length === 0 || want.filter((x) => have.has(x.id)).length / want.length >= 0.5);
        } else if (row.tool === 'graph_path') {
          const r = findPath(index, String(row.args['a']), String(row.args['b']), { directed: false, maxHops: 8 });
          pass = r.found && r.hops.length <= (row.structured['hops'] as unknown[]).length + 1;
        } else if (row.tool === 'graph_affected') {
          const have = new Set(affectedBy(index, String(row.args['node']), { depth: 3 }).groups.flatMap((g) => g.nodes.map((x) => x.id)));
          const want = (row.structured['code'] as { id: string }[]).filter((x) => !x.id.includes('_rationale_'));
          pass = want.length === 0 || want.filter((x) => have.has(x.id)).length / want.length >= 0.7;
        }
      } catch (e) {
        failing.push(`${row.id}: threw ${String(e).slice(0, 100)}`);
        continue;
      }
      if (pass) score++;
      else failing.push(row.id);
    }
    console.log(`GRAPH_QUERY_SCORE ${score}/30 (vacuous ${vacuous}); not matching: ${failing.join(', ') || 'none'}`);
    expect(vacuous).toBeLessThanOrEqual(3);
    expect(score).toBeGreaterThanOrEqual(27);
  }, 900_000);
});
