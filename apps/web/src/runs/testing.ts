/** Test helpers (not exported from index.ts): a throw-away schema `ctc_t61_<random>` on the scratch Postgres, step fixtures and a route caller. */
import { createHash, randomBytes } from 'node:crypto';
import { createDb, createRepositories, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import type { Route } from '../library/http.ts';
import { runsRoutes, type RunsDeps } from './index.ts';

export type Scratch = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t61_${randomBytes(4).toString('hex')}`;
  await migrate({ url, schema });
  const db = createDb({ url, schema });
  return {
    repos: createRepositories(db),
    schema,
    async drop() {
      try {
        await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
      } finally {
        await db.close();
      }
    },
  };
}

export const rnd = (): string => randomBytes(4).toString('hex');
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newUser = (): Ctx => ({ userId: `u-${rnd()}` });

export const mkRun = (repos: Repositories, ctx: Ctx, status = 'running') => repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', status });

/** Inserts a step with a fresh token; returns the row and the plain token. */
export async function mkStep(
  repos: Repositories, ctx: Ctx, runId: number, o: { status?: string; attempt?: number; failureCount?: number; nodeId?: string; noToken?: boolean } = {},
) {
  const token = `tok-${rnd()}${rnd()}`;
  const { step } = await repos.runner.insertStep(ctx, {
    runId, nodeId: o.nodeId ?? `n-${rnd()}`, visit: 1, attempt: o.attempt ?? 1, status: o.status ?? 'running', failureCount: o.failureCount ?? 0,
    ...(o.noToken ? {} : { tokenHash: sha(token) }),
  });
  return { step, token };
}

export type Call = { status: number; body: any; sends: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Calls the route `<METHOD> <url>`; the request carries `ctx` for the default `ctxOf` below. */
export async function call(routes: Route[], url: string, req: Record<string, unknown>): Promise<Call> {
  const r = routes.find((x) => `${x.method} ${x.url}` === url);
  if (!r) throw new Error(`route missing: ${url}`);
  const out: Call = { status: 0, body: undefined, sends: 0 };
  const reply = {
    code(n: number) {
      out.status = n;
      return { send(b?: unknown) { out.body = b; out.sends++; return b; } };
    },
  };
  await r.handler({ params: {}, headers: {}, ...req } as Parameters<Route['handler']>[0], reply);
  return out;
}

export const URLS = {
  retry: 'POST /api/runs/:rid/steps/:sid/retry', fail: 'POST /api/runs/:rid/steps/:sid/fail',
  cancel: 'POST /api/runs/:rid/cancel', report: 'POST /api/runs/:rid/steps/:sid/report',
} as const;

/** Deps whose `ctxOf` reads `req.ctx`; `enqueued` collects the ids passed to `enqueueStep`. */
export function mkDeps(repos: Repositories, over: { [K in keyof RunsDeps]?: RunsDeps[K] | undefined } = {}): { deps: RunsDeps; routes: Route[]; enqueued: number[] } {
  const enqueued: number[] = [];
  const deps: RunsDeps = {
    repos, config: { runner: { max_failures: 3 } }, ctxOf: (req) => (req as { ctx?: Ctx }).ctx ?? { userId: 'local' },
    enqueueStep: async (_c, s) => { enqueued.push(s.id); }, log: () => undefined, ...(over as Partial<RunsDeps>),
  };
  return { deps, routes: runsRoutes(deps), enqueued };
}
