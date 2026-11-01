/**
 * Long-term memories and session summaries of one user. Called from the memory worker, the web routes and the MCP `mem_*` tools
 * through `repos.memory`. A "live" memory is not soft-deleted and not superseded.
 * Deliberately NOT done: embedding calls, similarity thresholds, RRF fusion (packages/core); this module returns the two search legs.
 */
import { sql, type RawBuilder } from 'kysely';
import { isUuid, needProject, type Ctx } from './ctx.ts';
import { changed, first, jsonb, rows, vec, type Db, type K } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { clampLimit, limits } from './limits.ts';
import { memoryHash } from '../memory-hash/index.ts';
import { keyset, type Page } from './page.ts';

export type Memory = {
  id: string; userId: string; scope: string; projectId: string | null; kind: string; text: string; hash: string; source: unknown;
  supersededBy: string | null; confidence: number; pinned: boolean; reinforcementDates: string[]; createdAt: Date; updatedAt: Date;
  lastUsedAt: Date | null; useCount: number; deletedAt: Date | null;
};
export type MemoryInput = { scope: 'global' | 'project'; kind: string; text: string; embedding: number[]; confidence?: number; source?: unknown };
export type Summary = {
  sessionId: string; userId: string; projectId: string; request: string; investigated: string; learned: string; completed: string;
  nextSteps: string; notes: string; contentHash: string; createdAt: Date;
};
export type SummaryInput = Pick<Summary, 'sessionId' | 'contentHash'> & Partial<Pick<Summary, 'request' | 'investigated' | 'learned' | 'completed' | 'nextSteps' | 'notes'>>;

const COLS = sql.raw(
  'm.id, m.user_id, m.scope, m.project_id, m.kind, m.text, m.hash, m.source, m.superseded_by, m.confidence, m.pinned, m.reinforcement_dates, m.created_at, m.updated_at, m.last_used_at, m.use_count, m.deleted_at',
);
const RET = sql.raw('id, user_id, scope, project_id, kind, text, hash, source, superseded_by, confidence, pinned, reinforcement_dates, created_at, updated_at, last_used_at, use_count, deleted_at');
const SUMMARY_COLS = sql.raw('session_id, user_id, project_id, request, investigated, learned, completed, next_steps, notes, content_hash, created_at');
const LIVE = sql.raw('m.deleted_at is null and m.superseded_by is null');
const KINDS = ['preference', 'convention', 'fact', 'skill_outcome'];
const MAX_LEG = 100;
const MAX_NEIGHBOURS = 10;
/** 0..10, anything else is 0. */
const neighbours = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), MAX_NEIGHBOURS) : 0);

/** Words that match nearly every memory; the `simple` config keeps them. */
const STOP_WORDS = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in is it its me my no not of on or our should so that the their them then there these they this to us was we were what when where which who why will with would you your'.split(' '),
);

/**
 * Full-text query of free text: its words joined by OR (the `simple` config does no stemming). `plainto_tsquery` ANDs every word, so a whole sentence matches almost nothing. At most 24 distinct words of 2..40 characters; `''` when none.
 */
function tsQueryOf(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{2,40}/gu) ?? []).filter((w) => !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 24).join(' | ');
}

/** Scope filter for reads without an explicit scope: the user's global memories plus the ctx project's, or everything of the user without a project. */
const visible = (ctx: Ctx) =>
  ctx.projectId === undefined ? sql`` : sql`and (m.scope = 'global' or m.project_id = ${ctx.projectId})`;

export const memoryRepo = (db: Db) => {
  const k = db.kysely;

  const insert = async (x: K, ctx: Ctx, memory: MemoryInput): Promise<Memory> => {
    if (memory?.scope !== 'global' && memory?.scope !== 'project') throw new RepoError('invalid', 'scope must be global or project');
    if (typeof memory.text !== 'string' || memory.text.trim() === '') throw new RepoError('invalid', 'text required');
    if (!KINDS.includes(memory.kind)) throw new RepoError('invalid', 'bad kind');
    const projectId = memory.scope === 'project' ? needProject(ctx) : null;
    const embedding = vec(memory.embedding);
    const row = await first<Memory>(
      x,
      sql`insert into memories (user_id, scope, project_id, kind, text, hash, source, confidence, embedding)
          select ${ctx.userId}, ${memory.scope}, ${projectId}, ${memory.kind}, ${memory.text}, ${memoryHash(memory.text)}, ${jsonb(memory.source ?? {})},
                 coalesce(${memory.confidence ?? null}::real, 0.5), ${embedding}
          where ${projectId}::text is null or exists (select 1 from projects p where p.user_id = ${ctx.userId} and p.id = ${projectId})
          on conflict (user_id, scope, project_id, hash) do update set
            deleted_at = null, superseded_by = null,
            reinforcement_dates = case when current_date = any(memories.reinforcement_dates) then memories.reinforcement_dates else memories.reinforcement_dates || current_date end,
            updated_at = now()
          returning ${RET}`,
    );
    if (!row) throw new RepoError('not_found', 'project not found');
    return row;
  };

  const one = (ctx: Ctx, id: string) =>
    isUuid(id) ? first<Memory>(k, sql`select ${COLS} from memories m where m.user_id = ${ctx.userId} and m.id = ${id}`) : Promise.resolve(null);

  return {
    /** Live memories of the scope (and of `ctx.projectId` for scope `project`) by cosine similarity, best first. */
    async nearest(ctx: Ctx, o: { scope: 'global' | 'project'; embedding: number[]; limit: number }): Promise<{ memory: Memory; similarity: number }[]> {
      const embedding = vec(o?.embedding);
      const scope = o.scope === 'project' ? sql`and m.scope = 'project' and m.project_id = ${needProject(ctx)}` : sql`and m.scope = 'global'`;
      const got = await rows<Memory & { similarity: number }>(
        k,
        sql`select ${COLS}, 1 - (m.embedding <=> ${embedding}) as similarity from memories m
            where m.user_id = ${ctx.userId} and ${LIVE} and m.embedding is not null ${scope}
            order by m.embedding <=> ${embedding}, m.id limit ${clampLimit(o.limit)}`,
      );
      return got.map(({ similarity, ...memory }) => ({ memory: memory as Memory, similarity }));
    },
    /** Same text (after normalisation) in the same scope reinforces: today is appended once to `reinforcementDates`. A deleted or superseded row of that text comes back to life: the text was asserted again. */
    add: (ctx: Ctx, memory: MemoryInput) => insert(k, ctx, memory),
    /** Appends `date` (YYYY-MM-DD) only when it is not in the array yet. */
    async reinforce(ctx: Ctx, id: string, date: string): Promise<number> {
      if (!isUuid(id)) return 0;
      return changed(
        k,
        sql`update memories set reinforcement_dates = reinforcement_dates || ${String(date)}::date, updated_at = now()
            where user_id = ${ctx.userId} and id = ${id} and not (${String(date)}::date = any(reinforcement_dates))`,
      );
    },
    /** Replaces text, hash and embedding in place; the id stays. A hash that already exists is a `ConflictError`. */
    async rewrite(ctx: Ctx, id: string, o: { text: string; embedding: number[]; hash: string }): Promise<Memory | null> {
      const embedding = vec(o?.embedding);
      if (!isUuid(id)) return null;
      try {
        return await first<Memory>(
          k,
          sql`update memories set text = ${String(o.text)}, hash = ${String(o.hash)}, embedding = ${embedding}, updated_at = now()
              where user_id = ${ctx.userId} and id = ${id} and deleted_at is null returning ${RET}`,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictError('memory already exists');
        throw error;
      }
    },
    /** One transaction: inserts `newMemory` and marks the old row superseded. `null` (and nothing inserted) when the old row is not a live row of this user. */
    async supersede(ctx: Ctx, oldId: string, newMemory: MemoryInput): Promise<Memory | null> {
      if (!isUuid(oldId)) return null;
      return k.transaction().execute(async (trx) => {
        const old = await first<{ id: string }>(
          trx,
          sql`select m.id from memories m where m.user_id = ${ctx.userId} and m.id = ${oldId} and ${LIVE} for update`,
        );
        if (!old) return null;
        const created = await insert(trx, ctx, newMemory);
        if (created.id !== oldId) {
          await changed(trx, sql`update memories set superseded_by = ${created.id}, updated_at = now() where user_id = ${ctx.userId} and id = ${oldId}`);
        }
        return created;
      });
    },
    get: one,
    async getMany(ctx: Ctx, ids: string[]): Promise<Memory[]> {
      if (!Array.isArray(ids)) throw new RepoError('invalid', 'ids must be an array');
      if (ids.length > limits.manyIds) throw new RepoError('invalid', `at most ${limits.manyIds} ids`);
      const valid = ids.filter(isUuid);
      if (valid.length === 0) return [];
      return rows<Memory>(k, sql`select ${COLS} from memories m where m.user_id = ${ctx.userId} and m.id = any(${valid}::uuid[]) order by m.created_at, m.id`);
    },
    async list(ctx: Ctx, o: { scope?: string; kind?: string; q?: string; limit?: number; cursor?: string } | null = {}): Promise<Page<Memory>> {
      o ??= {};
      const scope = o.scope === undefined ? visible(ctx) : sql`and m.scope = ${String(o.scope)}`;
      const projectOfScope = o.scope === 'project' && ctx.projectId !== undefined ? sql`and m.project_id = ${ctx.projectId}` : sql``;
      const kind = o.kind === undefined ? sql`` : sql`and m.kind = ${String(o.kind)}`;
      const q = o.q === undefined || o.q === '' ? sql`` : sql`and strpos(lower(m.text), lower(${String(o.q)})) > 0`;
      return keyset<Memory>(
        k,
        sql`select ${COLS}, m.created_at as page_ts, m.id::text as page_id from memories m
            where m.user_id = ${ctx.userId} and ${LIVE} ${scope} ${projectOfScope} ${kind} ${q}`,
        o,
      );
    },
    /** A new `text` recomputes the hash; the embedding of the new text comes with it (`embedding`), else the old vector stays rather than leaving the row out of every vector search. An empty patch returns the current row. */
    async patch(ctx: Ctx, id: string, p: { text?: string; embedding?: number[]; pinned?: boolean; kind?: string }): Promise<Memory | null> {
      if (!isUuid(id)) return null;
      const parts = [];
      if (typeof p?.text === 'string') {
        parts.push(sql`text = ${p.text}`, sql`hash = ${memoryHash(p.text)}`);
        if (p.embedding !== undefined) parts.push(sql`embedding = ${vec(p.embedding)}`);
      }
      if (typeof p?.pinned === 'boolean') parts.push(sql`pinned = ${p.pinned}`);
      if (p?.kind !== undefined) {
        if (!KINDS.includes(p.kind)) throw new RepoError('invalid', 'bad kind');
        parts.push(sql`kind = ${p.kind}`);
      }
      if (parts.length === 0) return one(ctx, id);
      try {
        return await first<Memory>(
          k,
          sql`update memories set ${sql.join(parts)}, updated_at = now() where user_id = ${ctx.userId} and id = ${id} and deleted_at is null returning ${RET}`,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictError('memory already exists');
        throw error;
      }
    },
    /** Soft delete. */
    async softDelete(ctx: Ctx, id: string): Promise<number> {
      if (!isUuid(id)) return 0;
      return changed(k, sql`update memories set deleted_at = now() where user_id = ${ctx.userId} and id = ${id} and deleted_at is null`);
    },
    /** The two candidate lists for hybrid recall (full-text and vector), `perLeg` clamped to 1..100. A `null` vector skips the vector leg (embedder down). */
    async recallLegs(ctx: Ctx, o: { queryText: string; queryVector: number[] | null; perLeg: number; globalOnly?: boolean; anyWord?: boolean }): Promise<{ fts: Memory[]; vec: Memory[] }> {
      const embedding = o?.queryVector === null ? null : vec(o?.queryVector);
      const perLeg = clampLimit(o.perLeg, MAX_LEG, MAX_LEG);
      const scope = o.globalOnly === true ? sql`and m.scope = 'global'` : visible(ctx);
      const text = typeof o.queryText === 'string' ? o.queryText.trim() : '';
      const ftsOf = (tsquery: RawBuilder<unknown>) =>
        rows<Memory>(
          k,
          sql`select ${COLS} from memories m where m.user_id = ${ctx.userId} and ${LIVE} ${scope} and m.tsv @@ ${tsquery}
              order by ts_rank(m.tsv, ${tsquery}) desc, m.id limit ${perLeg}`,
        );
      // a search query must match all its words; `anyWord` is for a sentence that is not a search (the start-of-session query), where AND matches almost nothing
      const anyWords = o.anyWord === true ? tsQueryOf(text) : '';
      const fts = text === '' || (o.anyWord === true && anyWords === '') ? [] : await ftsOf(o.anyWord === true ? sql`to_tsquery('simple', ${anyWords})` : sql`plainto_tsquery('simple', ${text})`);
      const near = embedding === null
        ? []
        : await rows<Memory>(
            k,
            sql`select ${COLS} from memories m where m.user_id = ${ctx.userId} and ${LIVE} ${scope} and m.embedding is not null
                order by m.embedding <=> ${embedding}, m.id limit ${perLeg}`,
          );
      return { fts, vec: near };
    },
    /** The anchor memory with up to 10 neighbours each way (by creation time), and the session summaries around it. Unknown anchor gives empty lists. */
    async timeline(ctx: Ctx, o: { anchorId: string; before: number; after: number }): Promise<{ memories: Memory[]; summaries: Summary[] }> {
      const empty = { memories: [], summaries: [] };
      if (!isUuid(o?.anchorId)) return empty;
      const anchor = await first<{ at: string }>(k, sql`select m.created_at::text as at from memories m where m.user_id = ${ctx.userId} and m.id = ${o.anchorId} and m.deleted_at is null`);
      if (!anchor) return empty;
      const before = neighbours(o.before);
      const after = neighbours(o.after);
      const project = ctx.projectId === undefined ? sql`` : sql`and s.project_id = ${ctx.projectId}`;
      const mem = (cmp: RawBuilder<unknown>, order: RawBuilder<unknown>, n: number) =>
        rows<Memory>(
          k,
          sql`select ${COLS} from memories m where m.user_id = ${ctx.userId} and m.deleted_at is null ${visible(ctx)} and ${cmp} order by ${order} limit ${n}`,
        );
      const sum = (cmp: RawBuilder<unknown>, order: RawBuilder<unknown>, n: number) =>
        rows<Summary>(
          k,
          sql`select ${SUMMARY_COLS} from session_summaries s where s.user_id = ${ctx.userId} ${project} and ${cmp} order by ${order} limit ${n}`,
        );
      const [mb, ma, me, sb, sa] = await Promise.all([
        before ? mem(sql`(m.created_at, m.id) < (${anchor.at}::timestamptz, ${o.anchorId}::uuid)`, sql`m.created_at desc, m.id desc`, before) : [],
        after ? mem(sql`(m.created_at, m.id) > (${anchor.at}::timestamptz, ${o.anchorId}::uuid)`, sql`m.created_at asc, m.id asc`, after) : [],
        one(ctx, o.anchorId),
        before ? sum(sql`s.created_at < ${anchor.at}::timestamptz`, sql`s.created_at desc`, before) : [],
        after ? sum(sql`s.created_at >= ${anchor.at}::timestamptz`, sql`s.created_at asc`, after) : [],
      ]);
      return { memories: [...mb.reverse(), ...(me ? [me] : []), ...ma], summaries: [...sb.reverse(), ...sa] };
    },
    /** `last_used_at = now()`, `use_count + 1` for the user's own ids; ids that are not uuids are ignored. */
    async touch(ctx: Ctx, ids: string[]): Promise<number> {
      if (!Array.isArray(ids)) throw new RepoError('invalid', 'ids must be an array');
      if (ids.length > limits.manyIds) throw new RepoError('invalid', `at most ${limits.manyIds} ids`);
      const valid = ids.filter(isUuid);
      if (valid.length === 0) return 0;
      return changed(k, sql`update memories set last_used_at = now(), use_count = use_count + 1 where user_id = ${ctx.userId} and id = any(${valid}::uuid[])`);
    },
    /** `true` when inserted; `false` when the same content already exists or the session is not the user's. A session may have several summaries, one per distinct content. */
    async insertSummary(ctx: Ctx, s: SummaryInput): Promise<boolean> {
      const r = await first(
        k,
        sql`insert into session_summaries (session_id, user_id, project_id, request, investigated, learned, completed, next_steps, notes, content_hash)
            select s.id, s.user_id, s.project_id, ${s.request ?? ''}, ${s.investigated ?? ''}, ${s.learned ?? ''}, ${s.completed ?? ''}, ${s.nextSteps ?? ''}, ${s.notes ?? ''}, ${String(s.contentHash)}
            from sessions s where s.id = ${String(s.sessionId)} and s.user_id = ${ctx.userId}
            on conflict do nothing returning session_id`,
      );
      return r !== null;
    },
    /** Newest first, for the project of ctx; a session that was summarized again shows its newest summary only. */
    async lastSummaries(ctx: Ctx, n: number): Promise<Summary[]> {
      const projectId = needProject(ctx);
      return rows<Summary>(
        k,
        sql`select ${SUMMARY_COLS} from (
              select distinct on (session_id) * from session_summaries where user_id = ${ctx.userId} and project_id = ${projectId} order by session_id, created_at desc
            ) s order by created_at desc, session_id desc limit ${clampLimit(n)}`,
      );
    },
    async getSummary(ctx: Ctx, sessionId: string): Promise<Summary | null> {
      return first<Summary>(k, sql`select ${SUMMARY_COLS} from session_summaries where user_id = ${ctx.userId} and session_id = ${String(sessionId)} order by created_at desc limit 1`);
    },
  };
};
