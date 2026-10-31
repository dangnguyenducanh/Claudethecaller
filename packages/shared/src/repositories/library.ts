/**
 * Capability library of one user: capabilities, immutable versions, files, blobs, labels, overrides, vectors.
 * Called from the library worker (createVersion), the web routes and the MCP find/get tools through `repos.library`.
 * Deliberately NOT done: scanning, hashing, the 200 files / 1 MB / name-regex limits (T3.1); this module only refuses `latest` as a label.
 * Child tables (`capability_versions`, `cap_files`, `cap_vectors`) are always reached through `capabilities.user_id` in the same statement (D11).
 */
import { sql } from 'kysely';
import { isUuid, type Ctx } from './ctx.ts';
import { changed, first, jsonb, parseVec, rows, vec, type Db } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type Capability = { id: string; userId: string; namespace: string; kind: string; name: string; rootPath: string; servedVersion: number | null; removedAt: Date | null; enrichment: unknown };
export type Version = { id: string; capId: string; version: number; bodyHash: string; description: string; frontmatter: unknown; labels: string[]; commitMessage: string | null; createdAt: Date };
export type ManifestEntry = { path: string; size: number | null; blobHash: string };
export type OverrideRow = { userId: string; projectId: string | null; capId: string; action: string; label: string | null; version: number | null };
export type CreateVersionInput = {
  namespace: string; kind: string; name: string; rootPath: string; description: string; frontmatter?: unknown; bodyHash: string; commitMessage?: string;
  blobs: { hash: string; content: string; size: number }[]; files: { path: string; blobHash: string }[];
};

const CAP_COLS = sql.raw('c.id, c.user_id, c.namespace, c.kind, c.name, c.root_path, c.served_version, c.removed_at, c.enrichment');
const VER_COLS = sql.raw('v.id, v.cap_id, v.version, v.body_hash, v.description, v.frontmatter, v.labels, v.commit_message, v.created_at');
const OVERRIDE_COLS = sql.raw('o.user_id, o.project_id, o.cap_id, o.action, o.label, o.version');
const LOCK_NOT_AVAILABLE = '55P03';

export const libraryRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /** Live (not removed) capabilities, newest first by their first version. */
    async listCapabilities(ctx: Ctx, o: { kind?: string; label?: string; q?: string; limit?: number; cursor?: string } | null = {}): Promise<Page<Capability>> {
      o ??= {};
      const kind = o.kind === undefined ? sql`` : sql`and c.kind = ${String(o.kind)}`;
      const label = o.label === undefined ? sql`` : sql`and exists (select 1 from capability_versions v where v.cap_id = c.id and ${String(o.label)} = any(v.labels))`;
      const q = o.q === undefined || o.q === '' ? sql`` : sql`and strpos(lower(c.name), lower(${String(o.q)})) > 0`;
      return keyset<Capability>(
        k,
        sql`select ${CAP_COLS}, coalesce((select min(v.created_at) from capability_versions v where v.cap_id = c.id), 'epoch'::timestamptz) as page_ts, c.id::text as page_id
            from capabilities c where c.user_id = ${ctx.userId} and c.removed_at is null ${kind} ${label} ${q}`,
        o,
      );
    },
    async get(ctx: Ctx, id: string): Promise<Capability | null> {
      if (!isUuid(id)) return null;
      return first<Capability>(k, sql`select ${CAP_COLS} from capabilities c where c.user_id = ${ctx.userId} and c.id = ${id}`);
    },
    async byName(ctx: Ctx, o: { namespace: string; kind: string; name: string }): Promise<Capability | null> {
      return first<Capability>(
        k,
        sql`select ${CAP_COLS} from capabilities c where c.user_id = ${ctx.userId} and c.namespace = ${String(o?.namespace)} and c.kind = ${String(o?.kind)} and c.name = ${String(o?.name)}`,
      );
    },
    /** Live capabilities of the caller with exactly that name, ordered by namespace then kind. */
    async listByName(ctx: Ctx, name: string): Promise<Capability[]> {
      return rows<Capability>(
        k,
        sql`select ${CAP_COLS} from capabilities c where c.user_id = ${ctx.userId} and c.name = ${String(name)} and c.removed_at is null
            order by c.namespace collate "C", c.kind collate "C"`,
      );
    },
    /**
     * One transaction under an advisory lock per (user, name): new version = max + 1, moves `latest`, stores blobs once.
     * A file manifest equal to the latest version's creates nothing (`created: false`). Version 1 also gets `production`.
     */
    async createVersion(ctx: Ctx, input: CreateVersionInput): Promise<{ version: Version; created: boolean }> {
      const u = ctx.userId;
      const files = input.files ?? [];
      const blobs = input.blobs ?? [];
      if (new Set(files.map((f) => f.path)).size !== files.length) throw new RepoError('invalid', 'duplicate file path');
      return k.transaction().execute(async (trx) => {
        await changed(trx, sql`select pg_advisory_xact_lock(hashtext('cap:' || ${u} || ':' || ${String(input.name)}))`);
        const cap = await first<{ id: string }>(
          trx,
          sql`insert into capabilities (user_id, namespace, kind, name, root_path) values (${u}, ${input.namespace}, ${input.kind}, ${input.name}, ${input.rootPath})
              on conflict (user_id, namespace, kind, name) do update set root_path = excluded.root_path, removed_at = null
              returning id`,
        );
        const capId = (cap as { id: string }).id;
        const latest = await first<Version>(
          trx,
          sql`select ${VER_COLS} from capability_versions v join capabilities c on c.id = v.cap_id
              where c.user_id = ${u} and v.cap_id = ${capId} order by v.version desc limit 1`,
        );
        if (latest) {
          const have = await rows<{ path: string; blobHash: string }>(
            trx,
            sql`select f.path, f.blob_hash from cap_files f join capability_versions v on v.id = f.version_id join capabilities c on c.id = v.cap_id
                where c.user_id = ${u} and f.version_id = ${latest.id}`,
          );
          const key = (x: { path: string; blobHash: string }): string => `${x.path}\0${x.blobHash}`;
          const same = have.length === files.length && new Set(have.map(key)).size === new Set([...have.map(key), ...files.map(key)]).size;
          if (same) return { version: latest, created: false };
        }
        await changed(
          trx,
          sql`insert into cap_blobs (user_id, hash, content, size)
              select ${u}, x.hash, x.content, x.size from jsonb_to_recordset(${jsonb(blobs)}) as x(hash text, content text, size int)
              on conflict (user_id, hash) do nothing`,
        );
        const hashes = [...new Set(files.map((f) => f.blobHash))];
        const known = await first<{ n: number }>(trx, sql`select count(*)::int as n from cap_blobs where user_id = ${u} and hash = any(${hashes}::text[])`);
        if ((known?.n ?? 0) !== hashes.length) throw new RepoError('invalid', 'a file refers to a blob that was not provided');
        const next = (latest?.version ?? 0) + 1;
        if (latest) {
          await changed(
            trx,
            sql`update capability_versions v set labels = array_remove(v.labels, 'latest')
                from capabilities c where c.id = v.cap_id and c.user_id = ${u} and v.cap_id = ${capId} and 'latest' = any(v.labels)`,
          );
        }
        const labels = next === 1 ? ['latest', 'production'] : ['latest'];
        const created = await first<Version>(
          trx,
          sql`insert into capability_versions (cap_id, version, body_hash, description, frontmatter, labels, commit_message)
              select c.id, ${next}, ${input.bodyHash}, ${input.description}, ${jsonb(input.frontmatter ?? {})}, ${labels}::text[], ${input.commitMessage ?? null}
              from capabilities c where c.id = ${capId} and c.user_id = ${u}
              returning ${sql.raw('id, cap_id, version, body_hash, description, frontmatter, labels, commit_message, created_at')}`,
        );
        const version = created as Version;
        await changed(
          trx,
          sql`insert into cap_files (version_id, path, blob_hash)
              select v.id, x.path, x."blobHash" from capability_versions v join capabilities c on c.id = v.cap_id,
                jsonb_to_recordset(${jsonb(files)}) as x(path text, "blobHash" text)
              where v.id = ${version.id} and c.user_id = ${u}`,
        );
        return { version, created: true };
      });
    },
    async listVersions(ctx: Ctx, capId: string): Promise<Version[]> {
      if (!isUuid(capId)) return [];
      return rows<Version>(
        k,
        sql`select ${VER_COLS} from capability_versions v join capabilities c on c.id = v.cap_id
            where c.user_id = ${ctx.userId} and v.cap_id = ${capId} order by v.version desc`,
      );
    },
    async getVersion(ctx: Ctx, capId: string, version: number): Promise<Version | null> {
      if (!isUuid(capId)) return null;
      return first<Version>(
        k,
        sql`select ${VER_COLS} from capability_versions v join capabilities c on c.id = v.cap_id
            where c.user_id = ${ctx.userId} and v.cap_id = ${capId} and v.version = ${Number(version)}`,
      );
    },
    async getVersionById(ctx: Ctx, versionId: string): Promise<Version | null> {
      if (!isUuid(versionId)) return null;
      return first<Version>(
        k,
        sql`select ${VER_COLS} from capability_versions v join capabilities c on c.id = v.cap_id where c.user_id = ${ctx.userId} and v.id = ${versionId}`,
      );
    },
    async manifest(ctx: Ctx, versionId: string): Promise<ManifestEntry[]> {
      if (!isUuid(versionId)) return [];
      return rows<ManifestEntry>(
        k,
        sql`select f.path, b.size, f.blob_hash
            from cap_files f join capability_versions v on v.id = f.version_id join capabilities c on c.id = v.cap_id
              left join cap_blobs b on b.user_id = c.user_id and b.hash = f.blob_hash
            where c.user_id = ${ctx.userId} and f.version_id = ${versionId} order by f.path collate "C"`,
      );
    },
    /** Content of that file of that version only. */
    async getBlob(ctx: Ctx, versionId: string, path: string): Promise<string | null> {
      if (!isUuid(versionId)) return null;
      const r = await first<{ content: string }>(
        k,
        sql`select b.content
            from cap_files f join capability_versions v on v.id = f.version_id join capabilities c on c.id = v.cap_id
              join cap_blobs b on b.user_id = c.user_id and b.hash = f.blob_hash
            where c.user_id = ${ctx.userId} and f.version_id = ${versionId} and f.path = ${String(path)}`,
      );
      return r ? r.content : null;
    },
    /**
     * Puts each label on `version` and removes it from the other versions of the capability, in one transaction with the target locked.
     * `latest` is refused (`invalid`); a lock held by someone else gives `ConflictError`.
     */
    async moveLabels(ctx: Ctx, o: { capId: string; version: number; labels: string[] }): Promise<Version | null> {
      const labels = [...new Set(Array.isArray(o?.labels) ? o.labels.map(String) : [])];
      if (labels.includes('latest')) throw new RepoError('invalid', 'latest cannot be moved');
      if (!isUuid(o.capId)) return null;
      try {
        return await k.transaction().execute(async (trx) => {
          const target = await first<{ id: string }>(
            trx,
            sql`select v.id from capability_versions v join capabilities c on c.id = v.cap_id
                where c.user_id = ${ctx.userId} and v.cap_id = ${o.capId} and v.version = ${Number(o.version)} for update of v nowait`,
          );
          if (!target) return null;
          await changed(
            trx,
            sql`update capability_versions v set labels = array(select l from unnest(v.labels) l where l <> all(${labels}::text[]))
                from capabilities c where c.id = v.cap_id and c.user_id = ${ctx.userId} and v.cap_id = ${o.capId} and v.id <> ${target.id} and v.labels && ${labels}::text[]`,
          );
          return first<Version>(
            trx,
            sql`update capability_versions v set labels = array(select distinct l from unnest(v.labels || ${labels}::text[]) l order by l)
                from capabilities c where c.id = v.cap_id and c.user_id = ${ctx.userId} and v.id = ${target.id}
                returning ${VER_COLS}`,
          );
        });
      } catch (error) {
        if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw new ConflictError('version is being changed');
        throw error;
      }
    },
    async setServed(ctx: Ctx, capId: string, version: number): Promise<number> {
      if (!isUuid(capId)) return 0;
      return changed(
        k,
        sql`update capabilities c set served_version = ${Number(version)}
            where c.user_id = ${ctx.userId} and c.id = ${capId} and exists (select 1 from capability_versions v where v.cap_id = c.id and v.version = ${Number(version)})`,
      );
    },
    /** Soft delete: sets `removed_at` once; already removed or foreign gives 0. */
    async markRemoved(ctx: Ctx, capId: string): Promise<number> {
      if (!isUuid(capId)) return 0;
      return changed(k, sql`update capabilities set removed_at = now() where user_id = ${ctx.userId} and id = ${capId} and removed_at is null`);
    },
    /** One override per (project, capability); with no `ctx.projectId` it is the user's global override. The version or label must exist (`not_found`). */
    async upsertOverride(ctx: Ctx, o: { capId: string; action: string; label?: string; version?: number }): Promise<OverrideRow> {
      if (!isUuid(o?.capId)) throw new RepoError('not_found', 'capability not found');
      const project = ctx.projectId ?? null;
      const version = o.version ?? null;
      const label = o.label ?? null;
      const row = await first<OverrideRow>(
        k,
        sql`insert into overrides (user_id, project_id, cap_id, action, label, version)
            select c.user_id, ${project}, c.id, ${String(o.action)}, ${label}, ${version}
            from capabilities c
            where c.id = ${o.capId} and c.user_id = ${ctx.userId}
              and (${version}::int is null or exists (select 1 from capability_versions v where v.cap_id = c.id and v.version = ${version}))
              and (${label}::text is null or exists (select 1 from capability_versions v where v.cap_id = c.id and ${label} = any(v.labels)))
            on conflict (user_id, project_id, cap_id) do update set action = excluded.action, label = excluded.label, version = excluded.version
            returning ${sql.raw('user_id, project_id, cap_id, action, label, version')}`,
      );
      if (!row) throw new RepoError('not_found', 'capability, version or label not found');
      return row;
    },
    async clearOverride(ctx: Ctx, capId: string): Promise<number> {
      if (!isUuid(capId)) return 0;
      return changed(k, sql`delete from overrides where user_id = ${ctx.userId} and cap_id = ${capId} and project_id is not distinct from ${ctx.projectId ?? null}`);
    },
    /** With `ctx.projectId`: global overrides plus that project's; without: global ones. */
    async listOverrides(ctx: Ctx): Promise<OverrideRow[]> {
      return rows<OverrideRow>(
        k,
        sql`select ${OVERRIDE_COLS} from overrides o where o.user_id = ${ctx.userId} and (o.project_id is null or o.project_id = ${ctx.projectId ?? null}) order by o.cap_id, o.project_id nulls first`,
      );
    },
    async upsertVector(ctx: Ctx, o: { capId: string; textHash: string; embedding: number[]; model?: string }): Promise<number> {
      const embedding = vec(o?.embedding);
      if (!isUuid(o.capId)) return 0;
      // judgment: the schema requires `model`; callers that do not know it store ''.
      return changed(
        k,
        sql`insert into cap_vectors (cap_id, text_hash, embedding, model)
            select c.id, ${String(o.textHash)}, ${embedding}, ${o.model ?? ''} from capabilities c where c.id = ${o.capId} and c.user_id = ${ctx.userId}
            on conflict (cap_id, text_hash) do update set embedding = excluded.embedding, model = excluded.model`,
      );
    },
    /** Deletes the capability's vectors whose `text_hash` is not `keepTextHash` (only the served version is embedded). Foreign or non-uuid id gives 0. */
    async pruneVectors(ctx: Ctx, capId: string, keepTextHash: string): Promise<number> {
      if (!isUuid(capId)) return 0;
      return changed(
        k,
        sql`delete from cap_vectors x using capabilities c
            where c.id = x.cap_id and c.user_id = ${ctx.userId} and x.cap_id = ${capId} and x.text_hash <> ${String(keepTextHash)}`,
      );
    },
    async loadVectors(ctx: Ctx): Promise<{ capId: string; textHash: string; embedding: number[] }[]> {
      const got = await rows<{ capId: string; textHash: string; embedding: string }>(
        k,
        sql`select x.cap_id, x.text_hash, x.embedding::text as embedding from cap_vectors x join capabilities c on c.id = x.cap_id
            where c.user_id = ${ctx.userId} and c.removed_at is null order by x.cap_id, x.text_hash`,
      );
      return got.map((r) => ({ capId: r.capId, textHash: r.textHash, embedding: parseVec(r.embedding) }));
    },
    /**
     * Live capabilities of the caller that have a vector, one row each (the lowest `text_hash` when pruning lags), with the description of the
     * served version (`''` when none), ordered by `cap_id`. One statement: the skill channel loads its RAM matrix from this.
     */
    async loadSkillIndex(ctx: Ctx): Promise<{ capId: string; namespace: string; kind: string; name: string; description: string; embedding: number[] }[]> {
      const got = await rows<{ capId: string; namespace: string; kind: string; name: string; description: string; embedding: string }>(
        k,
        sql`select distinct on (x.cap_id) x.cap_id, c.namespace, c.kind, c.name, coalesce(v.description, '') as description, x.embedding::text as embedding
            from cap_vectors x
            join capabilities c on c.id = x.cap_id
            left join capability_versions v on v.cap_id = c.id and v.version = c.served_version
            where c.user_id = ${ctx.userId} and c.removed_at is null
            order by x.cap_id, x.text_hash`,
      );
      return got.map((r) => ({ capId: r.capId, namespace: r.namespace, kind: r.kind, name: r.name, description: r.description, embedding: parseVec(r.embedding) }));
    },
  };
};
