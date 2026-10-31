/**
 * The ten `/api` routes of the skill library (D9, D15-D19). Called from: the ctc-web bootstrap, which mounts each `Route` with
 * `app.route({ method, url, handler })`; the dashboard Library page calls them. Why: the dashboard lists, compares, relabels, pins and restores.
 * Deliberately NOT done: Fastify, auth, `Idempotency-Key`, enrich and dedup routes (D7). Untrusted: params, query and body; a handler never throws.
 */
import { diffManifests } from '@ctc/core/library';
import { keys } from '@ctc/shared/cache';
import {
  CapabilityListQuery, DiffQuery, LabelsBody, OverrideBody, OverrideParams, RestoreBody, VersionParams, libraryApiLimits,
} from '@ctc/shared/schemas/library';
import { RepoError, type Ctx } from '@ctc/shared/repositories';
import {
  ApiError, capabilityJson, ctxFor, errorBody, notFound, parse, statusOf, toApiError, versionJson, type LibraryApiDeps, type Route,
} from './http.ts';
import { manifestAndBody } from './read.ts';
import { restore } from './restore.ts';

type Req = { params?: unknown; query?: unknown; body?: unknown };
type Result = { status: number; body?: unknown };

/** `:id` only routes: the path value must be a string (a value that is not the caller's capability is `not_found`, never `invalid`, D4). */
function idParam(params: unknown): string {
  const id = (params as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string') throw new ApiError('invalid', 'id must be a string', { path: ['params', 'id'] });
  return id;
}

const logError = (deps: LibraryApiDeps, message: string, e: unknown): void =>
  deps.log?.(message, { error: e instanceof Error ? e.constructor.name : typeof e });

/** Tells the other web processes and this one to forget the project's `ovr:` rows (D17). */
async function rotateOverrides(deps: LibraryApiDeps, ctx: Ctx, projectId: string): Promise<void> {
  const { cache } = deps;
  if (!cache) return;
  try {
    await cache.del(keys.ovr(ctx.userId, projectId));
    await cache.publishInval({ v: 1, event: 'ovr.changed', userId: ctx.userId, projectId });
  } catch (e) {
    logError(deps, 'ovr rotate failed', e);
  }
}

/** The project of the caller or `not_found`. Returns the ctx scoped to it (D1b). */
async function projectCtx(deps: LibraryApiDeps, ctx: Ctx, pid: string): Promise<Ctx> {
  if ((await deps.repos.projects.get(ctx, pid)) === null) throw notFound('project not found');
  return { ...ctx, projectId: pid };
}

export function libraryRoutes(deps: LibraryApiDeps): Route[] {
  const { repos } = deps;
  const route = (method: Route['method'], url: string, run: (req: Req, ctx: Ctx) => Promise<Result>): Route => ({
    method,
    url,
    async handler(req, reply) {
      let result: Result;
      try {
        result = await run(req ?? {}, ctxFor(deps, req));
      } catch (e) {
        const err = toApiError(e);
        if (err.code === 'internal') logError(deps, `${method} ${url} failed`, e);
        result = { status: statusOf(err), body: errorBody(err) };
      }
      return reply.code(result.status).send(result.body);
    },
  });

  return [
    route('GET', '/api/capabilities', async (req, ctx) => {
      const q = parse(CapabilityListQuery, 'query', req.query ?? {});
      const page = await repos.library
        .listCapabilities(ctx, {
          ...(q.kind === undefined ? {} : { kind: q.kind }), ...(q.label === undefined ? {} : { label: q.label }),
          ...(q.q === undefined ? {} : { q: q.q }), ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          limit: q.limit ?? libraryApiLimits.listDefault,
        })
        .catch((e: unknown) => {
          throw e instanceof RepoError && e.code === 'invalid' ? new ApiError('invalid', e.message, { path: ['query', 'cursor'] }) : e;
        });
      return { status: 200, body: { items: page.rows.map(capabilityJson), next: page.next } };
    }),

    route('GET', '/api/capabilities/:id', async (req, ctx) => {
      const cap = await repos.library.get(ctx, idParam(req.params));
      if (!cap) throw notFound('capability not found');
      return { status: 200, body: capabilityJson(cap) };
    }),

    route('GET', '/api/capabilities/:id/versions', async (req, ctx) => {
      const id = idParam(req.params);
      if (!(await repos.library.get(ctx, id))) throw notFound('capability not found');
      return { status: 200, body: { items: (await repos.library.listVersions(ctx, id)).map(versionJson) } };
    }),

    route('GET', '/api/capabilities/:id/versions/:v', async (req, ctx) => {
      const p = parse(VersionParams, 'params', req.params);
      const cap = await repos.library.get(ctx, p.id);
      const version = cap ? await repos.library.getVersion(ctx, p.id, p.v) : null;
      if (!cap || !version) throw notFound('version not found');
      const { manifest, body } = await manifestAndBody(deps, ctx, cap.kind, version.id);
      return { status: 200, body: { ...versionJson(version), files: manifest.map((m) => ({ path: m.path, size: m.size, blobHash: m.blobHash })), body } };
    }),

    route('GET', '/api/capabilities/:id/versions/:v/diff', async (req, ctx) => {
      const p = parse(VersionParams, 'params', req.params);
      const q = parse(DiffQuery, 'query', req.query);
      const to = await repos.library.getVersion(ctx, p.id, p.v);
      const from = await repos.library.getVersion(ctx, p.id, q.against);
      if (!to || !from) throw notFound('version not found');
      const diff = diffManifests(await repos.library.manifest(ctx, from.id), await repos.library.manifest(ctx, to.id));
      return { status: 200, body: { from: from.version, to: to.version, ...diff } };
    }),

    route('PATCH', '/api/capabilities/:id/versions/:v/labels', async (req, ctx) => {
      const p = parse(VersionParams, 'params', req.params);
      const b = parse(LabelsBody, 'body', req.body);
      const moved = await repos.library.moveLabels(ctx, { capId: p.id, version: p.v, labels: b.labels }).catch((e: unknown) => {
        throw e instanceof RepoError && e.code === 'invalid' ? new ApiError('invalid', e.message, { path: ['body', 'labels'] }) : e;
      });
      if (!moved) throw notFound('version not found');
      try {
        await deps.submit({ queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId: p.id, version: p.v } });
      } catch (e) {
        logError(deps, 'library.changed submit failed', e);
      }
      return { status: 200, body: versionJson(moved) };
    }),

    route('POST', '/api/capabilities/:id/restore', async (req, ctx) => {
      const id = idParam(req.params);
      const b = parse(RestoreBody, 'body', req.body);
      return { status: 200, body: await restore(deps, ctx, id, b.version) };
    }),

    route('PUT', '/api/projects/:pid/capabilities/:id/override', async (req, ctx) => {
      const p = parse(OverrideParams, 'params', req.params);
      const b = parse(OverrideBody, 'body', req.body);
      const pctx = await projectCtx(deps, ctx, p.pid);
      const row = await repos.library.upsertOverride(pctx, {
        capId: p.id, action: b.action, ...(b.action === 'pin' && b.label !== undefined ? { label: b.label } : {}),
        ...(b.action === 'pin' && b.version !== undefined ? { version: b.version } : {}),
      });
      await rotateOverrides(deps, ctx, p.pid);
      return { status: 200, body: { projectId: p.pid, capId: row.capId, action: row.action, label: row.label ?? null, version: row.version ?? null } };
    }),

    route('DELETE', '/api/projects/:pid/capabilities/:id/override', async (req, ctx) => {
      const p = parse(OverrideParams, 'params', req.params);
      const pctx = await projectCtx(deps, ctx, p.pid);
      await repos.library.clearOverride(pctx, p.id);
      await rotateOverrides(deps, ctx, p.pid);
      return { status: 204 };
    }),

    route('POST', '/api/index', async (_req, ctx) => {
      const job = await deps.submit({ queue: 'library', kind: 'scan', payload: { userId: ctx.userId } });
      return { status: 202, body: { job_id: job.id } };
    }),
  ];
}
