/**
 * Test helpers (not exported from index.ts): a hand-made graph, fake dependencies that record every call, and the helpers of the two gates
 * (scratch Postgres and Redis guards, the on-disk vector cache, percentile, the git snapshot of the n8n-parity tickets and its graph).
 * Called from: the *.test.ts files of this directory. Why: pure tests need no database; the gates need the same setup twice.
 * Deliberately NOT done: anything exported to other modules, restarting a service. Only the scratch Postgres 127.0.0.1:18304 and Redis 127.0.0.1:18395
 * and the TEI embedder are ever reached.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, type GEdge, type GNode, type GraphIndex } from '@ctc/core/graph/query';
import { queryText } from '@ctc/core/skills';
import type { SuggestDeps } from './index.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../../..');
export const DIM = 1024;
export const BODY = { prompt: 'runWidget', cwd: '/work/zeta' };
export const EXP = 'ctc: T9.1 Build the widget runner → src/widget.ts:runWidget · skill: tdd · decision: D3';
export const HIT = { capId: 'c1', namespace: 'n', kind: 'skill', name: 'tdd', rank: 1, cosine: 0.8, rerank: null };
export const qprefixed = (prompt: string): string => queryText(prompt, 'skillret');

export const vec = (m: Record<number, number>): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(m)) v[Number(i)] = x;
  return v;
};
/** A unit vector whose cosine to axis 0 is `c`. */
export const at = (c: number): number[] => vec({ 0: c, 1: Math.sqrt(Math.max(0, 1 - c * c)) });
export const E0 = vec({ 0: 1 });

export const nd = (id: string, kind: string, type: string, label: string, sourceFile: string | null = null, sourceLocation: string | null = null): GNode => ({
  id, kind, type, label, sourceFile, sourceLocation, meta: {},
});
export const ed = (src: string, dst: string, relation: string, confidence = 'EXTRACTED'): GEdge => ({ src, dst, relation, confidence, score: 1 });

export const ID = {
  T1: 'ctx:specs/zeta/tasks:T9.1', T2: 'ctx:specs/zeta/tasks:T9.2', D1: 'ctx:specs/zeta/spec:D3', F: 'code:src_widget', FN: 'code:src_widget_runwidget',
  G: 'code:src_gadget_polish', S: 'skill:tdd', P: 'code:pkg_react',
};
export const NODES: GNode[] = [
  nd(ID.T1, 'context', 'task', 'Build the widget runner', 'specs/zeta/tasks.md', 'L5'),
  nd(ID.T2, 'context', 'task', 'Polish the gadget', 'specs/zeta/tasks.md', 'L6'),
  nd(ID.D1, 'context', 'decision', 'Widgets retry twice', 'specs/zeta/spec.md', 'L9'),
  nd(ID.F, 'code', 'file', 'widget.ts', 'src/widget.ts', 'L1'),
  nd(ID.FN, 'code', 'function', 'runWidget()', 'src/widget.ts', 'L10'),
  nd(ID.G, 'code', 'function', 'polishGadget()', 'src/gadget.ts', 'L3'),
  nd(ID.S, 'capability', 'skill', 'tdd'),
  nd(ID.P, 'code', 'package', 'react'),
];
export const EDGES: GEdge[] = [
  ed(ID.F, ID.FN, 'contains'), ed(ID.T1, ID.FN, 'implements', 'INFERRED'), ed(ID.D1, ID.FN, 'decides'), ed(ID.S, ID.T1, 'serves', 'INFERRED'), ed(ID.T2, ID.G, 'implements'),
];
export const graphOf = (vectors: { id: string; embedding: number[] }[] = [], nodes = NODES, edges = EDGES, hubMin?: number): GraphIndex =>
  buildIndex({ nodes, edges, vectors, ...(hubMin ? { hubMin } : {}) });

export type FakeOptions = {
  index?: GraphIndex; vectors?: { id: string; embedding: number[] }[]; epoch?: { v: string | null }; seedCache?: [string, string][];
  byRootFails?: boolean; noProject?: boolean; embedDelay?: number; embedIgnoreSignal?: boolean; embedFails?: boolean; embedVec?: number[]; graphFails?: boolean;
  skillsFail?: boolean; blockedSkills?: string[]; hits?: unknown[]; skillDegraded?: string[]; noCache?: boolean; cacheGetFails?: boolean; cacheSetFails?: boolean; cacheSetHangs?: boolean;
  epochFails?: boolean; query?: Record<string, number>; push?: Record<string, number>; ctxOf?: (req: unknown) => unknown;
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });

/** Fake dependencies. `st` records the order of events and every call; `st.forbidden` lists any property read that the task never uses. */
export function fakeDeps(o: FakeOptions = {}) {
  const st = {
    ev: [] as string[], byRoot: [] as [unknown, string][], embed: [] as string[][], search: [] as unknown[][], graph: [] as unknown[], sets: [] as [string, { line?: string }, number][],
    gets: [] as string[], logs: [] as unknown[][], forbidden: [] as string[],
  };
  const index = o.index ?? graphOf(o.vectors ?? []);
  const epoch = o.epoch ?? { v: 'e1' };
  const store = new Map<string, string>(o.seedCache ?? []);
  const pre = (k: string): string => k.split(':')[0] as string;
  const forbid = <T extends object>(target: T, what: string): T =>
    new Proxy(target, { get: (t, p) => { if (typeof p === 'symbol' || p in t) return Reflect.get(t, p); st.forbidden.push(`${what}.${String(p)}`); return undefined; } });
  const repos = forbid({
    projects: {
      byRoot: async (ctx: { userId: string }, root: string) => {
        st.ev.push('byRoot'); st.byRoot.push([ctx, root]);
        if (o.byRootFails) throw new Error('db down');
        if (o.noProject) return null;
        const p = ({ 'u-a': 'p1', 'u-b': 'p2', local: 'p0' } as Record<string, string>)[ctx.userId];
        return p ? { id: p, root } : null;
      },
    },
  }, 'repository');
  const tei = forbid({
    embed: async (texts: string[], opts?: { signal?: AbortSignal }) => {
      st.ev.push('embed'); st.embed.push(texts);
      if (o.embedDelay) await wait(o.embedDelay, o.embedIgnoreSignal ? undefined : opts?.signal);
      if (o.embedFails) throw new Error('tei down');
      return texts.map(() => o.embedVec ?? E0);
    },
  }, 'tei');
  const config = {
    embed: { instruction: 'skillret' }, embedding_dim: DIM,
    graph: { query: { seeds: 3, depth: 2, hub_min: 50, ...(o.query ?? {}) } }, graph_push: { floor: 0.3, max_pointers: 3, max_chars: 400, ...(o.push ?? {}) },
  };
  const graph = {
    get: async (ctx: unknown) => { st.ev.push('graph'); st.graph.push(ctx); if (o.graphFails) throw new Error('db down'); return { index, loadedAt: 0, epoch: 'e1' }; },
  };
  const skills = {
    search: async (ctx: unknown, prompt: unknown, opts: unknown) => {
      st.ev.push('search'); st.search.push([ctx, prompt, opts]);
      if (o.skillsFail) throw new Error('boom');
      return { hits: o.hits ?? [], degraded: o.skillDegraded ?? [], ms: { load: 0, embed: 0, rank: 0, rerank: 0, total: 0 } };
    },
    blocked: async () => new Set(o.blockedSkills ?? []),
  };
  const cache = o.noCache ? undefined : {
    get: async (k: string) => { st.ev.push(`cacheGet:${pre(k)}`); st.gets.push(k); if (o.cacheGetFails) throw new Error('redis'); return store.has(k) ? JSON.parse(store.get(k) as string) : undefined; },
    set: async (k: string, v: unknown, ttl: number) => {
      st.ev.push(`cacheSet:${pre(k)}`); st.sets.push([k, v as { line?: string }, ttl]);
      if (o.cacheSetHangs && pre(k) === 'sug') return new Promise<void>(() => undefined);
      if (o.cacheSetFails) throw new Error('redis');
      store.set(k, JSON.stringify(v));
      return undefined;
    },
    epoch: { get: async () => { st.ev.push('epoch'); if (o.epochFails) throw new Error('redis'); return epoch.v; } },
  };
  const deps = {
    repos, tei, config, graph, skills, ...(cache ? { cache } : {}),
    ctxOf: o.ctxOf ?? ((req: unknown) => (req as { ctx?: unknown } | null)?.ctx ?? { userId: 'u-a' }),
    log: (m: string, f?: unknown) => void st.logs.push([m, f]),
  } as unknown as SuggestDeps;
  return { deps, st, store, epoch };
}

export const reply = () => {
  const r: { c?: number; b?: unknown; code(n: number): { send(b?: unknown): typeof r } } = {
    code(n) { r.c = n; return { send: (b) => { r.b = b; return r; } }; },
  };
  return r;
};
export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

// ---- gates ----------------------------------------------------------------------------------------------------------------

export const GATE_ON = process.env['CTC_GATE_SUGGEST'] === '1';
export const EVAL = path.join(ROOT, '.ctc-dev/eval');
export const SNAPSHOT_SHA = 'a8ad531efdc4aebfd61d98f499ffe0a8dbaf68cb';

/** The scratch Postgres URL; refuses anything but 127.0.0.1:18304. */
export function scratchPgUrl(): string {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? 'postgresql://postgres:ctcdev@127.0.0.1:18304/postgres';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  return url;
}
/** The scratch Redis URL; refuses anything but 127.0.0.1:18395. */
export function scratchRedisUrl(): string {
  const url = process.env['CTC_SCRATCH_REDIS_URL'] ?? 'redis://127.0.0.1:18395';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18395') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Redis 127.0.0.1:18395`);
  return url;
}

/** Vectors on disk under `.ctc-dev/eval/vec-cache/`, one file per `emb:` key. */
export function diskCache(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key: string): string => path.join(dir, `${key.replace(/[^a-z0-9]/gi, '-')}.f32`);
  return {
    async getVec(key: string): Promise<Float32Array | undefined> {
      try {
        const b = fs.readFileSync(file(key));
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      } catch {
        return undefined;
      }
    },
    async setVec(key: string, v: ArrayLike<number>): Promise<void> {
      fs.writeFileSync(file(key), Buffer.from(Float32Array.from(v).buffer));
    },
  };
}

/** Linear interpolation between order statistics (numpy default). `sorted` ascending. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/** `git archive <sha>` extracted to `.ctc-dev/eval/ctx-snapshot-<short>/` (kept when already present). Returns the directory. */
export function extractSnapshot(sha: string = SNAPSHOT_SHA): string {
  const dir = path.join(EVAL, `ctx-snapshot-${sha.slice(0, 7)}`);
  if (fs.existsSync(path.join(dir, '.snapshot-done'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tarball = execFileSync('git', ['archive', sha], { cwd: ROOT, maxBuffer: 1 << 30 });
  const r = spawnSync('tar', ['-x', '-C', dir], { input: tarball });
  if (r.status !== 0) throw new Error(`tar exited ${String(r.status)}`);
  fs.writeFileSync(path.join(dir, '.snapshot-done'), sha);
  return dir;
}

/** The first `# NN — slug` line of an issue file as `{ id: 'NN', title: 'slug with spaces' }`, or `null`. */
export function ticketTitle(text: string): { id: string; title: string } | null {
  const m = /^#\s+(\d{2})\s+[—-]+\s+(.+?)\s*$/m.exec(text);
  return m ? { id: m[1] as string, title: (m[2] as string).replace(/-/g, ' ') } : null;
}
