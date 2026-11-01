import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobCleanupHandlers } from './index.ts';
import { scratchRepos, type ScratchRepos } from './testing.ts';

let s: ScratchRepos;
beforeAll(async () => {
  s = await scratchRepos('ctc_t32_');
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const blob = (t: string) => ({ hash: sha(t), content: t, size: Buffer.byteLength(t) });
const hctx = { jobId: 'j', attempt: 1, signal: new AbortController().signal, setProgress: async () => undefined };

describe('cleanup.blobs against Postgres (D20)', () => {
  it('deletes only blobs that no file references', async () => {
    const u = { userId: `u-${randomBytes(3).toString('hex')}` };
    const kept = blob(`kept-${randomBytes(3).toString('hex')}`);
    const orphan = blob(`orphan-${randomBytes(3).toString('hex')}`);
    const { version } = await s.repos.library.createVersion(u, {
      namespace: 'user', kind: 'skill', name: 'blob-cap', rootPath: '/x', description: 'd', bodyHash: 'h',
      blobs: [kept, orphan], files: [{ path: 'SKILL.md', blobHash: kept.hash }],
    });
    const handler = blobCleanupHandlers({ repos: s.repos })['cleanup.blobs'] as unknown as (p: unknown, c: typeof hctx) => Promise<{ deleted: number }>;
    const out = await handler({}, hctx);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await s.repos.library.getBlob(u, version.id, 'SKILL.md')).toBe(kept.content);
    const again = await handler({}, hctx);
    expect(again.deleted).toBe(0);
  });
});
