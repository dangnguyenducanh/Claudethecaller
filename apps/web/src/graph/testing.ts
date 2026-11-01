/**
 * Test helpers (not exported from index.ts): a small hand-made graph and fake dependencies that count loads, submits, reviews and epoch rotations.
 * Called from: the *.test.ts files of this directory. Why: pure tests of the tools, routes and store need no database. Deliberately NOT done:
 * Postgres, Redis or the embedder (the gate test graph.query.int.test.ts uses the real ones), anything exported to other modules.
 */
import type { GraphApiDeps } from './common.ts';

type Row = { id: string; kind: string; type: string; label: string; sourceFile: string | null; sourceLocation: string | null; meta: unknown; origin: string; contentHash: string; updatedAt: Date };
const node = (id: string, type: string, label: string, sourceFile: string | null, loc: string | null, meta: unknown = {}): Row => ({
  id, kind: id.startsWith('ctx:') ? 'context' : 'code', type, label, sourceFile, sourceLocation: loc, meta, origin: 'ast', contentHash: '', updatedAt: new Date(0),
});
const edge = (src: string, dst: string, relation: string, confidence = 'EXTRACTED') => ({ src, dst, relation, confidence, score: 1, origin: 'ast', sourceLocation: null });

export const GRAPH = {
  nodes: [
    node('code:a', 'file', 'a.ts', 'src/a.ts', 'L1'),
    node('code:a_main', 'function', 'main()', 'src/a.ts', 'L3'),
    node('code:a_help', 'function', 'helper()', 'src/a.ts', 'L10'),
    node('code:b', 'file', 'b.ts', 'src/b.ts', 'L1'),
    node('code:b_help', 'function', 'helper()', 'src/b.ts', 'L2'),
    node('code:b_W', 'class', 'Widget', 'src/b.ts', 'L8', { lines: [8, 90] }),
    node('code:c_G', 'class', 'Gadget', 'src/c.ts', 'L2'),
    node('ctx:T9.1', 'task', 'T9.1 Build the widget runner', 'specs/x/spec.md', 'L12'),
  ],
  edges: [
    edge('code:a', 'code:a_main', 'contains'), edge('code:a', 'code:a_help', 'contains'), edge('code:b', 'code:b_help', 'contains'), edge('code:b', 'code:b_W', 'contains'),
    edge('code:a', 'code:b', 'imports'), edge('code:a_main', 'code:b_help', 'calls'), edge('code:c_G', 'code:b_W', 'inherits'), edge('ctx:T9.1', 'code:b_W', 'implements', 'INFERRED'),
  ],
};
export const VECTOR_OF_WIDGET = Array.from({ length: 1024 }, (_, k) => (k === 1 ? 1 : 0));
export const FILE_B = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
export const CTX = { userId: 'u1', projectId: 'p1' };

export type Fake = ReturnType<typeof fakeDeps>;
/** `over.loadFails(n)` fails the n-th graph load; `over.epoch` is the mutable Redis epoch; `over.deps` is merged last. */
export function fakeDeps(over: { loadFails?: (n: number) => boolean; epoch?: { v: string | null }; review?: unknown; deps?: Partial<GraphApiDeps>; query?: Record<string, number> } = {}) {
  const st = { loads: 0, vecLoads: 0, submits: [] as unknown[], reviews: [] as unknown[], rotates: [] as unknown[], calls: [] as unknown[] };
  const epoch = over.epoch ?? { v: 'e1' };
  const deps = {
    repos: {
      graph: {
        loadGraph: async () => {
          st.loads++;
          if (over.loadFails?.(st.loads)) throw new Error('db down');
          return structuredClone(GRAPH);
        },
        loadVectors: async () => {
          st.vecLoads++;
          return [{ id: 'code:b_W', embedding: VECTOR_OF_WIDGET }];
        },
        stats: async () => ({ nodesByType: { file: 3 }, edgesByRelation: { calls: 2 }, lastBuild: new Date('2026-01-02T03:04:05Z') }),
        reviewEdge: async (_c: unknown, o: { src: string; dst: string; relation: string; confidence: string }) => {
          st.reviews.push(o);
          return over.review === undefined ? { ...o, score: 1, origin: 'review', sourceLocation: null } : over.review;
        },
      },
      projects: {
        get: async (c: { userId: string }, id: string) => (c.userId === 'u1' && id === 'p1' ? { id: 'p1', root: '/proj', name: 'p' } : null),
        byRoot: async (c: { userId: string }, root: string) => (c.userId === 'u1' && root === '/proj' ? { id: 'p1', root } : null),
      },
    },
    config: { graph: { query: { seeds: 3, depth: 2, hub_min: 50, budget_tokens: 2000, ...over.query } }, graph_push: { floor: 0.3 } },
    submit: async (i: unknown) => (st.submits.push(i), { id: 'job-1' }),
    cache: { epoch: { get: async () => epoch.v, rotate: async (...a: unknown[]) => (st.rotates.push(a), 'e9') } },
    ctxOf: (req: unknown) => (req as { ctx?: { userId: string } } | undefined)?.ctx ?? { userId: 'u1' },
    onToolCall: (i: unknown) => void st.calls.push(i),
    readText: async (_root: string, rel: string) => (rel === 'src/b.ts' ? FILE_B : null),
    now: () => 1_000_000,
    ...over.deps,
  } as unknown as GraphApiDeps;
  return { deps, st, epoch };
}
