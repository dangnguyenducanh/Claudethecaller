/**
 * Context + coding graph of one project (nodes, edges, sources). Called from the graph worker (build/replace), the MCP pull tools
 * and the dashboard through `repos.graph`. Every function needs `ctx.projectId`.
 * Deliberately NOT done: extraction, embedding calls, similarity maths (packages/core).
 */
import { sql } from 'kysely';
import { needProject, type Ctx } from './ctx.ts';
import { changed, first, jsonb, parseVec, rows, vec, type Db } from './db.ts';
import { RepoError } from './errors.ts';
import { clampLimit } from './limits.ts';

export type GraphNodeInput = { id: string; kind: string; type: string; label: string; sourceLocation?: string | null; contentHash?: string; meta?: unknown };
export type GraphEdgeInput = { src: string; dst: string; relation: string; confidence: string; score?: number; sourceLocation?: string | null };
export type GraphNode = { id: string; kind: string; type: string; label: string; sourceFile: string | null; sourceLocation: string | null; origin: string; contentHash: string; meta: unknown; updatedAt: Date };
export type GraphEdge = { src: string; dst: string; relation: string; confidence: string; score: number; origin: string; sourceLocation: string | null };
export type GraphSource = { file: string; contentHash: string; extractorVersion: string; builtAtCommit: string | null };

const CONFIDENCES = ['CONFIRMED', 'EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'DROPPED'];
const ORIGINS = ['ast', 'parser', 'claude', 'commit', 'review', 'session'];
/** FROM-SPEC (spec:268): rows of these origins are written by people and sessions, a rebuild never deletes them. */
const KEPT = ['review', 'session'];
const MAX_SEARCH = 50;

const NODE_COLS = sql.raw('id, kind, type, label, source_file, source_location, origin, content_hash, meta, updated_at');
const EDGE_COLS = sql.raw('src, dst, relation, confidence, score, origin, source_location');

export const graphRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /**
     * One transaction per `(origin, source_file)`: deletes the old nodes and the edges leaving them, inserts the new ones and
     * upserts `graph_sources`. Any failure leaves the old rows. `deleted`/`inserted` count nodes plus edges.
     * An edge a person reviewed (origin `review`) is never overwritten by a rebuild.
     */
    async replaceSource(
      ctx: Ctx,
      input: { origin: string; sourceFile: string; nodes: GraphNodeInput[]; edges: GraphEdgeInput[]; source: { contentHash: string; extractorVersion: string; builtAtCommit?: string | null } },
    ): Promise<{ deleted: number; inserted: number }> {
      const projectId = needProject(ctx);
      const { origin, sourceFile, source } = input;
      if (!ORIGINS.includes(origin)) throw new RepoError('invalid', 'bad origin');
      if (typeof sourceFile !== 'string' || sourceFile === '') throw new RepoError('invalid', 'sourceFile required');
      const nodes = (input.nodes ?? []).map((n) => ({
        id: n.id, kind: n.kind, type: n.type, label: n.label, source_location: n.sourceLocation ?? null,
        content_hash: n.contentHash ?? source.contentHash, meta: n.meta ?? {},
      }));
      const edges = (input.edges ?? []).map((e) => ({
        src: e.src, dst: e.dst, relation: e.relation, confidence: e.confidence, score: e.score ?? 1, source_location: e.sourceLocation ?? null,
      }));
      if (edges.some((e) => !CONFIDENCES.includes(e.confidence))) throw new RepoError('invalid', 'bad edge confidence');
      const u = ctx.userId;
      return k.transaction().execute(async (trx) => {
        let deleted = 0;
        if (!KEPT.includes(origin)) {
          deleted += await changed(trx, sql`delete from graph_edges e where e.user_id = ${u} and e.project_id = ${projectId} and e.origin = ${origin}
            and e.src in (select n.id from graph_nodes n where n.user_id = ${u} and n.project_id = ${projectId} and n.source_file = ${sourceFile} and n.origin = ${origin})`);
          deleted += await changed(trx, sql`delete from graph_nodes n where n.user_id = ${u} and n.project_id = ${projectId} and n.source_file = ${sourceFile} and n.origin = ${origin}`);
        }
        const n = await changed(trx, sql`insert into graph_nodes (user_id, project_id, id, kind, type, label, source_file, source_location, origin, content_hash, meta)
          select ${u}, ${projectId}, x.id, x.kind, x.type, x.label, ${sourceFile}, x.source_location, ${origin}, x.content_hash, x.meta
          from jsonb_to_recordset(${jsonb(nodes)}) as x(id text, kind text, type text, label text, source_location text, content_hash text, meta jsonb)
          on conflict (user_id, project_id, id) do update set kind = excluded.kind, type = excluded.type, label = excluded.label,
            source_file = excluded.source_file, source_location = excluded.source_location, origin = excluded.origin,
            content_hash = excluded.content_hash, meta = excluded.meta, updated_at = now()
          where graph_nodes.origin not in ('review', 'session')`);
        const e = await changed(trx, sql`insert into graph_edges (user_id, project_id, src, dst, relation, confidence, score, origin, source_location)
          select ${u}, ${projectId}, x.src, x.dst, x.relation, x.confidence, x.score, ${origin}, x.source_location
          from jsonb_to_recordset(${jsonb(edges)}) as x(src text, dst text, relation text, confidence text, score real, source_location text)
          on conflict (user_id, project_id, src, dst, relation) do update set confidence = excluded.confidence, score = excluded.score,
            origin = excluded.origin, source_location = excluded.source_location
          where graph_edges.origin not in ('review', 'session')`);
        await changed(trx, sql`insert into graph_sources (user_id, project_id, file, content_hash, extractor_version, built_at_commit)
          values (${u}, ${projectId}, ${sourceFile}, ${source.contentHash}, ${source.extractorVersion}, ${source.builtAtCommit ?? null})
          on conflict (user_id, project_id, file) do update set content_hash = excluded.content_hash,
            extractor_version = excluded.extractor_version, built_at_commit = excluded.built_at_commit`);
        return { deleted, inserted: n + e };
      });
    },
    async sourceNodeCount(ctx: Ctx, sourceFile: string): Promise<number> {
      const projectId = needProject(ctx);
      const r = await first<{ n: number }>(k, sql`select count(*)::int as n from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId} and source_file = ${String(sourceFile)}`);
      return r?.n ?? 0;
    },
    async listSources(ctx: Ctx): Promise<GraphSource[]> {
      const projectId = needProject(ctx);
      return rows<GraphSource>(k, sql`select file, content_hash, extractor_version, built_at_commit from graph_sources where user_id = ${ctx.userId} and project_id = ${projectId} order by file`);
    },
    /** All nodes and edges of the project, without embeddings. */
    async loadGraph(ctx: Ctx): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
      const projectId = needProject(ctx);
      const nodes = await rows<GraphNode>(k, sql`select ${NODE_COLS} from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId} order by id`);
      const edges = await rows<GraphEdge>(k, sql`select ${EDGE_COLS} from graph_edges where user_id = ${ctx.userId} and project_id = ${projectId} order by src, dst, relation`);
      return { nodes, edges };
    },
    async loadVectors(ctx: Ctx): Promise<{ id: string; embedding: number[] }[]> {
      const projectId = needProject(ctx);
      const got = await rows<{ id: string; embedding: string }>(k, sql`select id, embedding::text as embedding from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId} and embedding is not null order by id`);
      return got.map((r) => ({ id: r.id, embedding: parseVec(r.embedding) }));
    },
    async getNode(ctx: Ctx, id: string): Promise<GraphNode | null> {
      const projectId = needProject(ctx);
      return first<GraphNode>(k, sql`select ${NODE_COLS} from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId} and id = ${String(id)}`);
    },
    /** Edges in both directions. */
    async edgesOf(ctx: Ctx, id: string): Promise<GraphEdge[]> {
      const projectId = needProject(ctx);
      return rows<GraphEdge>(k, sql`select ${EDGE_COLS} from graph_edges where user_id = ${ctx.userId} and project_id = ${projectId} and (src = ${String(id)} or dst = ${String(id)}) order by src, dst, relation`);
    },
    async searchLabels(ctx: Ctx, o: { query: string; types?: string[]; limit?: number }): Promise<GraphNode[]> {
      const projectId = needProject(ctx);
      const query = typeof o?.query === 'string' ? o.query.trim() : '';
      if (query === '') return [];
      const types = Array.isArray(o.types) && o.types.length > 0 ? sql`and type = any(${o.types.map(String)}::text[])` : sql``;
      return rows<GraphNode>(
        k,
        sql`select ${NODE_COLS} from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId}
            and to_tsvector('simple', label) @@ plainto_tsquery('simple', ${query}) ${types}
            order by ts_rank(to_tsvector('simple', label), plainto_tsquery('simple', ${query})) desc, id limit ${clampLimit(o.limit, MAX_SEARCH, MAX_SEARCH)}`,
      );
    },
    async setEmbedding(ctx: Ctx, id: string, embedding: number[], contentHash: string): Promise<number> {
      const projectId = needProject(ctx);
      return changed(k, sql`update graph_nodes set embedding = ${vec(embedding)}, content_hash = ${String(contentHash)}, updated_at = now()
        where user_id = ${ctx.userId} and project_id = ${projectId} and id = ${String(id)}`);
    },
    /** Marks an existing edge as decided by a person (origin `review`). */
    async reviewEdge(ctx: Ctx, o: { src: string; dst: string; relation: string; confidence: 'CONFIRMED' | 'DROPPED' }): Promise<GraphEdge | null> {
      const projectId = needProject(ctx);
      if (o?.confidence !== 'CONFIRMED' && o?.confidence !== 'DROPPED') throw new RepoError('invalid', 'confidence must be CONFIRMED or DROPPED');
      return first<GraphEdge>(
        k,
        sql`update graph_edges set confidence = ${o.confidence}, origin = 'review'
            where user_id = ${ctx.userId} and project_id = ${projectId} and src = ${String(o.src)} and dst = ${String(o.dst)} and relation = ${String(o.relation)}
            returning ${EDGE_COLS}`,
      );
    },
    /** `lastBuild` is the newest node write of the project (the schema has no build timestamp). */
    async stats(ctx: Ctx): Promise<{ nodesByType: Record<string, number>; edgesByRelation: Record<string, number>; lastBuild: Date | null }> {
      const projectId = needProject(ctx);
      const t = await rows<{ k: string; n: number }>(k, sql`select type as k, count(*)::int as n from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId} group by type`);
      const r = await rows<{ k: string; n: number }>(k, sql`select relation as k, count(*)::int as n from graph_edges where user_id = ${ctx.userId} and project_id = ${projectId} group by relation`);
      const b = await first<{ at: Date | null }>(k, sql`select max(updated_at) as at from graph_nodes where user_id = ${ctx.userId} and project_id = ${projectId}`);
      return {
        nodesByType: Object.fromEntries(t.map((x) => [x.k, x.n])),
        edgesByRelation: Object.fromEntries(r.map((x) => [x.k, x.n])),
        lastBuild: b?.at ?? null,
      };
    },
  };
};
