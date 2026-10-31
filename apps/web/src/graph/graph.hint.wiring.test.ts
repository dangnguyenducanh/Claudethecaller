/**
 * Wiring of the pre-tool hook to the graph tools (DECISIONS D22, built later by the bootstrap):
 * `const caps = createSessionCaps(); graphTools({ ..., onToolCall: (i) => caps.markGraphCall(i) }); preRoutes({ ..., caps })`.
 * A `graph_search` call through `graphTools` and `preRoutes` (mounted by `mkRoute`) silences the next `Grep` hint of the same project, and a `Read` note still comes. Fakes only.
 */
import { buildIndex } from '@ctc/core/graph/query';
import { describe, expect, it } from 'vitest';
import { createSessionCaps } from '../pre/index.ts';
import { mkRoute } from '../pre/testing.ts';
import { graphTools } from './index.ts';
import { fakeDeps, GRAPH } from './testing.ts';

describe('graph.hint wiring', () => {
  it('a graph_search call marks the project quiet for Grep hints through caps.markGraphCall, and a Read note still comes', async () => {
    const caps = createSessionCaps();
    const graph = fakeDeps({ deps: { onToolCall: (i) => caps.markGraphCall(i) } });
    const index = buildIndex({ nodes: GRAPH.nodes, edges: GRAPH.edges });
    const route = mkRoute({
      repos: graph.deps.repos,
      config: { graph: { hint: { per_session: 5, quiet_s: 1800, max_nodes: 5 } }, graph_push: { max_chars: 400, note_max: 3 } } as never,
      graph: { get: async () => ({ index, loadedAt: 0, epoch: null }) },
      ctxOf: () => ({ userId: 'u1' }),
      caps,
    });
    const grep = { session_id: 'c1', cwd: '/proj', tool_name: 'Grep', tool_input: { pattern: 'Widget' } };
    const read = { session_id: 'c1', cwd: '/proj', tool_name: 'Read', tool_input: { file_path: '/proj/src/b.ts' } };

    expect((await route.post(grep)).body?.hookSpecificOutput.additionalContext).toBe('ctc: graph nodes matching this search: src/b.ts:Widget');

    const search = (graphTools(graph.deps)[0] as NonNullable<ReturnType<typeof graphTools>[number]>);
    expect(search.name).toBe('graph_search');
    await search.call({ userId: 'u1' }, { query: 'widget', cwd: '/proj' });

    expect((await route.post(grep)).code).toBe(204);
    const note = await route.post(read);
    expect(note.code).toBe(200);
    expect(note.body?.hookSpecificOutput.additionalContext).toMatch(/^ctc: src\/b\.ts · tasks: T9\.1 /);
  });
});
