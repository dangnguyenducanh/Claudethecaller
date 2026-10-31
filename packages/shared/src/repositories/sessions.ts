/** Sessions of one user's projects. Called from the hook route and the history importer through `repos.sessions`. */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { first, type Db } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type Session = { id: string; userId: string; projectId: string; startedAt: Date; endedAt: Date | null; model: string; tokens: number; transcriptPath: string | null };
export type SessionInput = { id: string; projectId: string; startedAt?: Date | string; endedAt?: Date | string | null; model?: string; tokens?: number; transcriptPath?: string | null };

const RET = sql.raw('id, user_id, project_id, started_at, ended_at, model, tokens, transcript_path');
const COLS = sql.raw('s.id, s.user_id, s.project_id, s.started_at, s.ended_at, s.model, s.tokens, s.transcript_path');

export const sessionsRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /**
     * Creates the session or merges a later call into it: a later call fills `endedAt`/`tokens`/`model`/`transcriptPath`,
     * and never clears a stored value with `null`. A project that is missing or not the user's gives `not_found`.
     */
    async upsert(ctx: Ctx, input: SessionInput): Promise<Session> {
      if (typeof input?.id !== 'string' || input.id === '' || typeof input.projectId !== 'string') throw new RepoError('invalid', 'id and projectId required');
      const row = await first<Session>(
        k,
        sql`insert into sessions (id, user_id, project_id, started_at, ended_at, model, tokens, transcript_path)
            select ${input.id}, p.user_id, p.id, coalesce(${input.startedAt ?? null}::timestamptz, now()), ${input.endedAt ?? null}::timestamptz,
                   coalesce(${input.model ?? null}::text, ''), coalesce(${input.tokens ?? null}::bigint, 0), ${input.transcriptPath ?? null}
            from projects p where p.user_id = ${ctx.userId} and p.id = ${input.projectId}
            on conflict (id) do update set
              ended_at = coalesce(excluded.ended_at, sessions.ended_at),
              model = case when excluded.model <> '' then excluded.model else sessions.model end,
              tokens = case when excluded.tokens > 0 then excluded.tokens else sessions.tokens end,
              transcript_path = coalesce(excluded.transcript_path, sessions.transcript_path)
            where sessions.user_id = excluded.user_id and sessions.project_id = excluded.project_id
            returning ${RET}`,
      );
      if (row) return row;
      const project = await first(k, sql`select 1 as ok from projects where user_id = ${ctx.userId} and id = ${input.projectId}`);
      if (!project) throw new RepoError('not_found', 'project not found');
      throw new ConflictError('session id already in use');
    },
    async get(ctx: Ctx, id: string): Promise<Session | null> {
      return first<Session>(k, sql`select ${COLS} from sessions s where s.user_id = ${ctx.userId} and s.id = ${String(id)}`);
    },
    async list(ctx: Ctx, o: { projectId?: string; limit?: number; cursor?: string } | null = {}): Promise<Page<Session>> {
      o ??= {};
      const project = o.projectId === undefined ? sql`` : sql`and s.project_id = ${String(o.projectId)}`;
      return keyset<Session>(
        k,
        sql`select ${COLS}, s.started_at as page_ts, s.id as page_id from sessions s where s.user_id = ${ctx.userId} ${project}`,
        o,
      );
    },
  };
};
