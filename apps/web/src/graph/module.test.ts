import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@ctc/core/graph/query';
import * as schemas from '@ctc/shared/schemas/graph';
import * as web from './index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const DIRS = ['packages/core/src/graph/query', 'packages/shared/src/schemas/graph', 'apps/web/src/graph'].map((d) => path.join(root, d));
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
const all = DIRS.flatMap(sources);
const read = (p: string): string => fs.readFileSync(p, 'utf8');

describe('graph module shape', () => {
  it('D0 every source file has a header that says who calls it and what it does not do; there is no hook or suggest file', () => {
    expect(all.length).toBeGreaterThanOrEqual(6);
    const bad = all.filter((f) => !/\/\*\*[\s\S]*Called from[\s\S]*\*\//.test(read(f).slice(0, 2500)) || !/NOT done/.test(read(f).slice(0, 2500)));
    expect(bad).toEqual([]);
    expect(all.filter((f) => /hook|suggest/i.test(path.basename(f)))).toEqual([]);
  });

  it('D7 non-goals: no server, SDK, process, queue, Redis or SQL client, no file write; D23 core imports only itself and sanitize', () => {
    const banned = /from\s+['"](fastify|@modelcontextprotocol\/[^'"]*|node:child_process|child_process|bullmq|ioredis|kysely|pg|node:net|node:http|node:https)['"]/;
    expect(all.filter((f) => banned.test(read(f)))).toEqual([]);
    expect(all.filter((f) => /\b(writeFile|appendFile|mkdir|rmSync|unlink|rename)\w*\s*\(/.test(read(f)))).toEqual([]);
    const coreImports = sources(DIRS[0] as string).flatMap((f) => [...read(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string));
    expect(coreImports.filter((s) => !s.startsWith('./') && !s.startsWith('../'))).toEqual([]);
    expect(coreImports.some((s) => /sanitize/.test(s))).toBe(true);
    expect(web.graphRoutes({ config: { graph: { query: { seeds: 3, depth: 2, hub_min: 50, budget_tokens: 2000 } }, graph_push: { floor: 0.3 } } } as never).some((r) => /hook|suggest/.test(r.url))).toBe(false);
  });

  it('D9 the public names are exactly the listed ones', () => {
    expect(Object.keys(core).sort()).toEqual(
      ['queryLimits', 'QueryError', 'buildIndex', 'resolveName', 'lexicalSeeds', 'denseSeeds', 'walkFrom', 'searchGraph', 'explainNode', 'findPath', 'affectedBy', 'neighborsOf', 'nodeRef', 'renderSearch', 'renderExplain', 'renderPath', 'renderAffected', 'renderNeighbors'].sort(),
    );
    expect(Object.keys(schemas).sort()).toEqual(
      ['graphApiLimits', 'GraphSearchArgs', 'GraphExplainArgs', 'GraphPathArgs', 'GraphAffectedArgs', 'GraphNeighborsArgs', 'GraphSearchQuery', 'GraphExplainQuery', 'GraphPathQuery', 'GraphAffectedQuery', 'GraphNeighborsQuery', 'GraphStatsQuery', 'GraphBuildBody', 'GraphEdgeBody'].sort(),
    );
    expect(Object.keys(web).sort()).toEqual(['createGraphStore', 'graphRoutes', 'graphTools', 'readExcerpt']);
    expect(read(path.join(root, 'packages/core/src/index.ts'))).toBe("export const name = '@ctc/core';\n");
  });

  it('D8 the tolerant choices are marked with a judgment comment', () => {
    expect(all.map(read).join('\n').split('judgment:').length - 1).toBeGreaterThanOrEqual(3);
  });
});
