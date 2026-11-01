import { describe, expect, it } from 'vitest';
import { projectOf } from './common.ts';

describe('projectOf on the narrow deps (T5.1 D23)', () => {
  it('needs only repos.projects and an optional cache; caches a found project and not a miss', async () => {
    const store = new Map<string, unknown>();
    const cache = { get: async <T>(k: string) => store.get(k) as T | undefined, set: async (k: string, v: unknown) => void store.set(k, v) };
    const repos = { projects: { byRoot: async (_c: unknown, root: string) => (root === '/r' ? { id: 'p9', root } : null) } };
    const deps = { repos, cache } as unknown as Parameters<typeof projectOf>[0];
    expect(await projectOf(deps, { userId: 'u' }, '/r')).toEqual({ id: 'p9', root: '/r' });
    expect(store.has('proj:u:/r')).toBe(true);
    expect(await projectOf(deps, { userId: 'u' }, '/none')).toBeNull();
    expect(store.has('proj:u:/none')).toBe(false);
    expect(await projectOf({ repos } as unknown as Parameters<typeof projectOf>[0], { userId: 'u' }, '/r')).toEqual({ id: 'p9', root: '/r' });
  });
});
