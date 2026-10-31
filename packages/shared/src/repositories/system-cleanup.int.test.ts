import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemCtx } from './ctx.ts';
import { scratch, type Scratch } from './scratch.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const count = async (hash: string): Promise<number> => (await sql<{ n: number }>`select count(*)::int as n from cap_blobs where hash = ${hash}`.execute(s.db.kysely)).rows[0]?.n ?? 0;

describe('deleteUnreferencedBlobs (D20b)', () => {
  it('waits for an open writer and keeps the blob that writer references', async () => {
    const u = { userId: `u-${randomBytes(3).toString('hex')}` };
    const { version } = await s.repos.library.createVersion(u, {
      namespace: 'user', kind: 'skill', name: 'lock-cap', rootPath: '/x', description: 'd', bodyHash: 'h', blobs: [{ hash: 'main-blob', content: 'm', size: 1 }], files: [{ path: 'SKILL.md', blobHash: 'main-blob' }],
    });
    await sql`insert into cap_blobs (user_id, hash, content, size) values (${u.userId}, 'race-blob', 'race', 4)`.execute(s.db.kysely);
    let settled = false;
    let cleanup: Promise<number> | undefined;
    await s.db.kysely.transaction().execute(async (trx) => {
      await sql`insert into cap_blobs (user_id, hash, content, size) values (${u.userId}, 'race-blob', 'race', 4) on conflict do nothing`.execute(trx);
      await sql`insert into cap_files (version_id, path, blob_hash) values (${version.id}, 'race.md', 'race-blob')`.execute(trx);
      cleanup = s.repos.system.cleanup.deleteUnreferencedBlobs(createSystemCtx('t32 test')).finally(() => (settled = true));
      cleanup.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
    });
    await cleanup;
    expect(await count('race-blob')).toBe(1);
    expect(await s.repos.library.getBlob(u, version.id, 'race.md')).toBe('race');
  });
  it('still deletes a blob that nothing references', async () => {
    const u = { userId: `u-${randomBytes(3).toString('hex')}` };
    await sql`insert into cap_blobs (user_id, hash, content, size) values (${u.userId}, 'orphan-blob', 'o', 1)`.execute(s.db.kysely);
    expect(await s.repos.system.cleanup.deleteUnreferencedBlobs(createSystemCtx('t32 test'))).toBeGreaterThanOrEqual(1);
    expect(await count('orphan-blob')).toBe(0);
  });
});
