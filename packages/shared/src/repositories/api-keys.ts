/** API keys of one user. The hash is write-only here; auth looks keys up through `system.apiKeys.findByHash`. */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { changed, first, rows, type Db } from './db.ts';
import { ConflictError } from './errors.ts';

export type ApiKeyRow = { id: number; name: string; createdAt: Date; revokedAt: Date | null };

export const apiKeysRepo = (db: Db) => {
  const k = db.kysely;
  return {
    async create(ctx: Ctx, input: { name: string; keyHash: string }): Promise<{ id: number; name: string; createdAt: Date }> {
      try {
        const r = await first<{ id: number; name: string; createdAt: Date }>(
          k,
          sql`insert into api_keys (user_id, name, key_hash) values (${ctx.userId}, ${input.name ?? ''}, ${input.keyHash}) returning id, name, created_at`,
        );
        return r as { id: number; name: string; createdAt: Date };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictError('key hash already in use');
        throw error;
      }
    },
    /** Never returns `keyHash`. */
    async list(ctx: Ctx): Promise<ApiKeyRow[]> {
      return rows<ApiKeyRow>(k, sql`select id, name, created_at, revoked_at from api_keys where user_id = ${ctx.userId} order by id`);
    },
    async revoke(ctx: Ctx, id: number): Promise<number> {
      if (!Number.isSafeInteger(Number(id)) || id === null || (id as unknown) === '') return 0;
      return changed(k, sql`update api_keys set revoked_at = now() where user_id = ${ctx.userId} and id = ${Number(id)} and revoked_at is null`);
    },
  };
};
