/** Test helpers (not exported from index.ts): a throw-away schema `ctc_t32_<random>` on the scratch Postgres, fakes for deps, request and tool callers. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, createRepositories, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { libraryRoutes, libraryTools, type LibraryApiDeps, type McpResult } from './index.ts';

export type Scratch = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema `ctc_t32_<random>`; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t32_${randomBytes(4).toString('hex')}`;
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
export const LOCAL: Ctx = { userId: 'local' };
export const skillMd = (name: string, desc: string, body: string): string => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

/** Temp directory under os.tmpdir(); `remove()` makes everything writable again first. */
export function tempDir(): { dir: string; sub(name: string): string; put(file: string, text: string): string; remove(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t32-'));
  return {
    dir,
    sub: (name) => path.join(dir, name),
    put(file, text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    remove() {
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            fs.chmodSync(p, 0o700);
            walk(p);
          }
        }
      };
      try {
        fs.chmodSync(dir, 0o700);
        walk(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Creates the next version of `name` holding `files` ({path: content}). */
export async function mkVersion(
  repos: Repositories, ctx: Ctx, name: string, files: Record<string, string>,
  o: { namespace?: string; kind?: string; rootPath?: string; commitMessage?: string; frontmatter?: unknown; description?: string } = {},
) {
  const entries = Object.entries(files);
  const blobs = [...new Map(entries.map(([, s]) => [sha(s), { hash: sha(s), content: s, size: Buffer.byteLength(s) }])).values()];
  const { version } = await repos.library.createVersion(ctx, {
    namespace: o.namespace ?? 'user', kind: o.kind ?? 'skill', name, rootPath: o.rootPath ?? `/nonexistent-t32/${name}`,
    description: o.description ?? `desc ${name}`, frontmatter: o.frontmatter ?? { name }, bodyHash: sha(JSON.stringify(files)),
    commitMessage: o.commitMessage ?? 'test', blobs, files: entries.map(([p, s]) => ({ path: p, blobHash: sha(s) })),
  });
  return version;
}

export type FakeSubmit = ((input: { queue: string; kind: string; payload: unknown; id?: string }) => Promise<{ id: string }>) & {
  calls: { queue: string; kind: string; payload: unknown; id?: string }[];
};
export function fakeSubmit(throws?: unknown): FakeSubmit {
  const calls: FakeSubmit['calls'] = [];
  const f = (async (input) => {
    calls.push(input);
    if (throws) throw throws;
    return { id: `job-${calls.length}` };
  }) as FakeSubmit;
  f.calls = calls;
  return f;
}

export type FakeCache = NonNullable<LibraryApiDeps['cache']> & { store: Map<string, string>; log: unknown[][] };
export function fakeCache(): FakeCache {
  const store = new Map<string, string>();
  const log: unknown[][] = [];
  return {
    store, log,
    async get<T>(k: string) {
      log.push(['get', k]);
      const v = store.get(k);
      return v === undefined ? undefined : (JSON.parse(v) as T);
    },
    async set(k, v, t) {
      log.push(['set', k, t]);
      store.set(k, JSON.stringify(v));
    },
    async del(...ks) {
      log.push(['del', ...ks]);
      for (const k of ks) store.delete(k);
    },
    async publishInval(msg) {
      log.push(['pub', msg]);
    },
  };
}

export function mkDeps(repos: Repositories, o: { home?: string; mode?: string; roots?: string[]; cache?: FakeCache; submit?: FakeSubmit; userId?: string } = {}): LibraryApiDeps {
  const home = o.home ?? os.tmpdir();
  return {
    repos,
    config: { mode: o.mode ?? 'local', claude_home: home, library: { roots: o.roots ?? [home], default_label: 'production' } },
    submit: o.submit ?? fakeSubmit(),
    ...(o.cache ? { cache: o.cache } : {}),
    ctxOf: (req) => (req as { ctx?: Ctx } | null)?.ctx ?? { userId: o.userId ?? 'local' },
  };
}

/** Calls one route handler and returns what it sent. */
export async function call(deps: LibraryApiDeps, method: string, url: string, req: { params?: unknown; query?: unknown; body?: unknown; ctx?: Ctx } = {}) {
  const r = libraryRoutes(deps).find((x) => x.method === method && x.url === url);
  if (!r) throw new Error(`no route ${method} ${url}`);
  let status = 0;
  let body: unknown;
  let sends = 0;
  const reply = { code(n: number) { status = n; return { send(b?: unknown) { sends++; body = b; return reply; } }; } };
  await r.handler({ params: {}, query: {}, ...req }, reply);
  return { status, body: body as any, sends }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function tool(deps: LibraryApiDeps, name: string, ctx: Ctx, args: unknown): Promise<McpResult> {
  const t = libraryTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.call(ctx, args);
}
export const okJson = (r: McpResult): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (r.isError) throw new Error(`tool error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
export const okText = (r: McpResult): string => {
  if (r.isError) throw new Error(`tool error: ${r.content[0].text}`);
  return r.content[0].text;
};
export const errOf = (r: McpResult): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
  expectError(r);
  return JSON.parse(r.content[0].text).error;
};
function expectError(r: McpResult): void {
  if (r.isError !== true) throw new Error(`expected a tool error, got ${r.content[0].text.slice(0, 80)}`);
}
