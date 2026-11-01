/** Test helpers (not exported from index.ts): a throw-away schema `ctc_t43_<random>` on the scratch Postgres, fake embedder / chat / cache / submit and callers for route handlers and tools. */
import { createHash, randomBytes } from 'node:crypto';
import type { Chat, Embed } from '@ctc/shared/models';
import { createDb, createRepositories, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { hookStartRoute, memoryRoutes, memoryTools, type MemoryApiDeps } from './index.ts';

export type Scratch = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema `ctc_t43_<random>`; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t43_${randomBytes(4).toString('hex')}`;
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

/** Deterministic unit vector of a text (same text gives cosine 1, different texts near 0). */
export function vecOf(text: string): number[] {
  let h = createHash('sha256').update(text).digest();
  const v = new Array<number>(1024);
  for (let i = 0; i < 1024; i++) {
    if (i % 32 === 0 && i > 0) h = createHash('sha256').update(h).digest();
    v[i] = (h[i % 32] as number) / 127.5 - 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export const fakeEmbed = (): Embed & { calls: string[][] } => {
  const calls: string[][] = [];
  const f = (async (texts: string[]) => {
    calls.push(texts);
    return texts.map(vecOf);
  }) as Embed & { calls: string[][] };
  f.calls = calls;
  return f;
};
export const fakeChat: Chat = async () => '{"relation":"same"}';

export const CONFIG: MemoryApiDeps['config'] = {
  memory: { context_chars: 10000, rrf: { k: 60, per_leg: 100 }, bands: { noop: 0.95, update: 0.85 }, half_life_days: 30, start: { summaries: 3, memories: 30 } },
};

export type FakeCache = NonNullable<MemoryApiDeps['cache']> & { store: Map<string, unknown>; sets: [string, unknown, number][]; rotates: unknown[][] };
export function fakeCache(epoch: string | null = 'e1'): FakeCache {
  const store = new Map<string, unknown>();
  const c: FakeCache = {
    store, sets: [], rotates: [],
    async get<T>(k: string) {
      return store.get(k) as T | undefined;
    },
    async set(k, v, t) {
      c.sets.push([k, v, t]);
      store.set(k, v);
    },
    epoch: {
      get: async () => epoch,
      rotate: async (...a) => {
        c.rotates.push(a);
        return 'r1';
      },
    },
  };
  return c;
}

export type FakeSubmit = MemoryApiDeps['submit'] & { calls: { queue: string; kind: string; payload: unknown; id?: string }[] };
export function fakeSubmit(): FakeSubmit {
  const calls: FakeSubmit['calls'] = [];
  const f = (async (input) => {
    calls.push(input);
    return { id: `job-${calls.length}` };
  }) as FakeSubmit;
  f.calls = calls;
  return f;
}

export function mkDeps(repos: Repositories, over: Partial<MemoryApiDeps> = {}): MemoryApiDeps {
  return {
    repos, config: structuredClone(CONFIG), embed: fakeEmbed(), chat: fakeChat, submit: fakeSubmit(),
    ctxOf: (req) => (req as { ctx?: Ctx } | null)?.ctx ?? { userId: 'local' },
    ...over,
  };
}

type Req = { params?: unknown; query?: unknown; body?: unknown; ctx?: Ctx };
const reply = () => {
  const out: { status: number; body: unknown } = { status: 0, body: undefined };
  return { out, reply: { code: (n: number) => ({ send: (b?: unknown) => ((out.status = n), (out.body = b), undefined) }) } };
};

export async function hook(deps: MemoryApiDeps, req: Req) {
  const r = reply();
  await hookStartRoute(deps).handler(req, r.reply);
  return r.out;
}
export async function api(deps: MemoryApiDeps, method: string, url: string, req: Req = {}) {
  const route = memoryRoutes(deps).find((x) => x.method === method && x.url === url);
  if (!route) throw new Error(`no route ${method} ${url}`);
  const r = reply();
  await route.handler(req, r.reply);
  return r.out as { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export async function tool(deps: MemoryApiDeps, name: string, ctx: Ctx, args: unknown) {
  const t = memoryTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.call(ctx, args);
}
export const textOf = (r: { content: [{ text: string }] }): string => r.content[0].text;
export const errOf = (r: { isError?: true; content: [{ text: string }] }) => {
  expectError(r);
  return (JSON.parse(r.content[0].text) as { error: { code: string; message: string; path?: unknown[] } }).error;
};
function expectError(r: { isError?: true }): void {
  if (r.isError !== true) throw new Error('expected isError');
}
