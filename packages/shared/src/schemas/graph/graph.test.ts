import { describe, expect, it } from 'vitest';
import {
  GraphAffectedArgs, GraphBuildBody, GraphEdgeBody, GraphExplainArgs, GraphNeighborsArgs, GraphPathArgs, GraphPathQuery, GraphSearchArgs, GraphSearchQuery, GraphStatsQuery,
  graphApiLimits,
} from './index.ts';

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => s.safeParse(v).success;

describe('graph schemas', () => {
  it('D1 bodies and args are strict: an unknown key such as userId is invalid', () => {
    expect(ok(GraphSearchArgs, { query: 'x', userId: 'evil' })).toBe(false);
    expect(ok(GraphBuildBody, { project_id: 'p1', userId: 'evil' })).toBe(false);
    expect(ok(GraphStatsQuery, { project_id: 'p1', cwd: '/tmp' })).toBe(false);
    expect(ok(GraphSearchArgs, { query: 'x' })).toBe(true);
    expect(ok(GraphExplainArgs, { name: 'x', cwd: 'relative/path' })).toBe(true);
  });

  it('D2 limits: the boundary is valid and one more is invalid; defaults are applied', () => {
    expect(graphApiLimits).toMatchObject({ queryHard: 20000, nameMax: 256, typesMax: 20, cwdMax: 4096 });
    const q = (v: Record<string, unknown>): boolean => ok(GraphSearchArgs, { query: 'x', ...v });
    expect([q({ query: 'x'.repeat(20000) }), q({ query: 'x'.repeat(20001) }), q({ limit: 50 }), q({ limit: 51 }), q({ limit: 0 }), q({ types: Array(20).fill('t') }), q({ types: Array(21).fill('t') })]).toEqual([
      true, false, true, false, false, true, false,
    ]);
    expect([ok(GraphExplainArgs, { name: 'n'.repeat(256) }), ok(GraphExplainArgs, { name: 'n'.repeat(257) }), ok(GraphExplainArgs, { name: '  ' })]).toEqual([true, false, false]);
    expect([ok(GraphAffectedArgs, { name: 'n', depth: 3 }), ok(GraphAffectedArgs, { name: 'n', depth: 4 })]).toEqual([true, false]);
    expect([ok(GraphPathArgs, { from: 'a', to: 'b', max_hops: 8 }), ok(GraphPathArgs, { from: 'a', to: 'b', max_hops: 9 })]).toEqual([true, false]);
    expect(GraphSearchArgs.parse({ query: 'x' }).limit).toBe(10);
    expect(GraphPathArgs.parse({ from: 'a', to: 'b' })).toMatchObject({ max_hops: 8, directed: true });
    expect(GraphNeighborsArgs.parse({ name: 'n' }).direction).toBe('both');
  });

  it('D19 route queries: integers, booleans and lists arrive as text and are coerced; the project is required', () => {
    expect(GraphSearchQuery.parse({ project_id: 'p', query: 'x', limit: '4', types: 'class, function,' })).toMatchObject({ limit: 4, types: ['class', 'function'] });
    expect(ok(GraphSearchQuery, { project_id: 'p', query: 'x', limit: '51' })).toBe(false);
    expect(ok(GraphSearchQuery, { query: 'x' })).toBe(false);
    expect(GraphPathQuery.parse({ project_id: 'p', from: 'a', to: 'b', directed: 'false' }).directed).toBe(false);
    expect(ok(GraphPathQuery, { project_id: 'p', from: 'a', to: 'b', directed: 'maybe' })).toBe(false);
    expect(ok(GraphEdgeBody, { project_id: 'p', src: 'a', dst: 'b', relation: 'calls', confidence: 'DROPPED' })).toBe(true);
    expect(ok(GraphEdgeBody, { project_id: 'p', src: 'a', dst: 'b', relation: 'calls', confidence: 'EXTRACTED' })).toBe(false);
  });
});
