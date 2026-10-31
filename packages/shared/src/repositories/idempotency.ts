/** Stored responses for idempotent POSTs, per user. Called from the web `Idempotency-Key` middleware through `repos.idempotency`. */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { first, jsonb, type Db } from './db.ts';

export const idempotencyRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /** The same key on another route is `null`. */
    async lookup(ctx: Ctx, o: { key: string; route: string }): Promise<{ payloadHash: string; response: unknown } | null> {
      return first(
        k,
        sql<{ payloadHash: string; response: unknown }>`select payload_hash, response from idempotency_keys
          where user_id = ${ctx.userId} and key = ${String(o?.key)} and route = ${String(o?.route)}`,
      );
    },
    /** `false` when the key already exists; nothing is overwritten. */
    async store(ctx: Ctx, o: { key: string; route: string; payloadHash: string; response: unknown }): Promise<boolean> {
      const r = await first(
        k,
        sql`insert into idempotency_keys (user_id, key, route, payload_hash, response)
            values (${ctx.userId}, ${o.key}, ${o.route}, ${o.payloadHash}, ${jsonb(o.response)})
            on conflict (user_id, key) do nothing returning key`,
      );
      return r !== null;
    },
    /** Replaces the response of the caller's receipt only while it is pending (`status` 0); `false` otherwise. */
    async settle(ctx: Ctx, o: { key: string; route: string; response: unknown }): Promise<boolean> {
      const r = await first(
        k,
        sql`update idempotency_keys set response = ${jsonb(o.response)}
            where user_id = ${ctx.userId} and key = ${String(o?.key)} and route = ${String(o?.route)} and response->>'status' = '0' returning key`,
      );
      return r !== null;
    },
    /** Deletes the caller's receipt only while it is pending (`status` 0); `false` otherwise. */
    async release(ctx: Ctx, o: { key: string; route: string }): Promise<boolean> {
      const r = await first(
        k,
        sql`delete from idempotency_keys
            where user_id = ${ctx.userId} and key = ${String(o?.key)} and route = ${String(o?.route)} and response->>'status' = '0' returning key`,
      );
      return r !== null;
    },
  };
};
