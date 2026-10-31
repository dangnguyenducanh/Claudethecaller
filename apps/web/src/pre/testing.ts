/**
 * Test helpers (not exported from index.ts): the hand-made ledger graph, fake dependencies that record every call, and the helpers of the gate
 * `failopen` (dead endpoints that refuse or hang, the ledger graph written through the repositories, closers with a bound).
 * Called from: the *.test.ts files of this directory and apps/web/src/graph/graph.hint.wiring.test.ts. Why: pure tests need no database; the gate
 * needs the same graph twice. Deliberately NOT done: anything exported to other modules, restarting a service. Only the scratch Postgres 127.0.0.1:18304,
 * the scratch Redis 127.0.0.1:18395 and the TEI embedder are ever reached; dead endpoints are loopback ports of this process.
 */
import net from 'node:net';
import { buildIndex, type GEdge, type GNode } from '@ctc/core/graph/query';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { scratchPgUrl, scratchRedisUrl } from '../suggest/testing.ts';
import { preRoutes, type PreDeps } from './index.ts';

export { scratchPgUrl, scratchRedisUrl };

export const ROOTDIR = '/work/ledger';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const cpLen = (s: string): number => Array.from(s).length;

export const nd = (id: string, kind: string, type: string, label: string, sourceFile: string | null = null, sourceLocation: string | null = null): GNode => ({
  id, kind, type, label, sourceFile, sourceLocation, meta: {},
});
export const ed = (src: string, dst: string, relation: string, confidence = 'EXTRACTED'): GEdge => ({ src, dst, relation, confidence, score: 1 });

export const ID = {
  F: 'code:src_ledger', PE: 'code:src_ledger_post', CB: 'code:src_ledger_close', AF: 'code:src_api', HP: 'code:src_api_handle', CF: 'code:src_cli', MN: 'code:src_cli_main',
  BF: 'code:src_batch', RB: 'code:src_batch_run', UF: 'code:src_audit', AT: 'code:src_audit_trail',
  T1: 'ctx:specs/ledger/tasks:T7.1', T2: 'ctx:specs/ledger/tasks:T7.2', T3: 'ctx:specs/ledger/tasks:T7.3', T4: 'ctx:specs/ledger/tasks:T7.4', D2: 'ctx:specs/ledger/spec:D2', D5: 'ctx:specs/ledger/spec:D5',
};
export const NODES: GNode[] = [
  nd(ID.F, 'code', 'file', 'ledger.ts', 'src/ledger.ts', 'L1'), nd(ID.PE, 'code', 'function', 'postEntry()', 'src/ledger.ts', 'L10'), nd(ID.CB, 'code', 'function', 'closeBooks()', 'src/ledger.ts', 'L30'),
  nd(ID.AF, 'code', 'file', 'api.ts', 'src/api.ts', 'L1'), nd(ID.HP, 'code', 'function', 'handlePost()', 'src/api.ts', 'L5'),
  nd(ID.CF, 'code', 'file', 'cli.ts', 'src/cli.ts', 'L1'), nd(ID.MN, 'code', 'function', 'main()', 'src/cli.ts', 'L2'),
  nd(ID.BF, 'code', 'file', 'batch.ts', 'src/batch.ts', 'L1'), nd(ID.RB, 'code', 'function', 'runBatch()', 'src/batch.ts', 'L7'),
  nd(ID.UF, 'code', 'file', 'audit.ts', 'src/audit.ts', 'L1'), nd(ID.AT, 'code', 'function', 'auditTrail()', 'src/audit.ts', 'L4'),
  nd(ID.T1, 'context', 'task', 'Post ledger entries', 'specs/ledger/tasks.md', 'L3'), nd(ID.T2, 'context', 'task', 'Close the books monthly', 'specs/ledger/tasks.md', 'L4'),
  nd(ID.T3, 'context', 'task', 'Audit every posting', 'specs/ledger/tasks.md', 'L5'), nd(ID.T4, 'context', 'task', 'Export ledger to CSV', 'specs/ledger/tasks.md', 'L6'),
  nd(ID.D2, 'context', 'decision', 'Entries are append only', 'specs/ledger/spec.md', 'L9'), nd(ID.D5, 'context', 'decision', 'Books close on the last day', 'specs/ledger/spec.md', 'L11'),
];
export const EDGES: GEdge[] = [
  ed(ID.F, ID.PE, 'contains'), ed(ID.F, ID.CB, 'contains'), ed(ID.AF, ID.HP, 'contains'), ed(ID.CF, ID.MN, 'contains'), ed(ID.BF, ID.RB, 'contains'), ed(ID.UF, ID.AT, 'contains'),
  ed(ID.T1, ID.PE, 'implements'), ed(ID.T2, ID.CB, 'implements', 'INFERRED'), ed(ID.T3, ID.F, 'implements', 'AMBIGUOUS'), ed(ID.T4, ID.PE, 'implements', 'AMBIGUOUS'),
  ed(ID.D2, ID.PE, 'decides'), ed(ID.D5, ID.CB, 'decides', 'INFERRED'),
  ed(ID.HP, ID.PE, 'calls'), ed(ID.MN, ID.PE, 'calls', 'INFERRED'), ed(ID.RB, ID.CB, 'calls', 'INFERRED'), ed(ID.AT, ID.PE, 'calls', 'AMBIGUOUS'), ed(ID.CB, ID.PE, 'calls'),
];
export const G1 = (nodes: GNode[] = NODES, edges: GEdge[] = EDGES) => buildIndex({ nodes, edges });

export const NOTE_FULL =
  'ctc: src/ledger.ts · tasks: T7.1 Post ledger entries; T7.2 Close the books monthly; T7.3 Audit every posting · decisions: D2 Entries are append only; D5 Books close on the last day · callers: src/api.ts:handlePost; src/batch.ts:runBatch; src/cli.ts:main';
export const HINT_PE = 'ctc: graph nodes matching this search: src/ledger.ts:postEntry';

/** A Claude Code PreToolUse body. */
export const body = (tool: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: 's1', transcript_path: '/t.jsonl', cwd: ROOTDIR, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', ...extra,
});
export const READ = (p = `${ROOTDIR}/src/ledger.ts`, extra: Record<string, unknown> = {}) => body('Read', { file_path: p }, extra);
export const GREP = (pattern: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) => body('Grep', { pattern, ...input }, extra);
export const wrap = (text: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

export type FakeOptions = {
  index?: ReturnType<typeof G1>; clock?: { t: number }; byRootDelay?: number; byRootFails?: boolean | number; noProject?: boolean; graphDelayFirst?: number; graphFails?: boolean;
  noCache?: boolean; cacheGetFails?: boolean; cacheSetFails?: boolean; ctxOf?: (req: unknown) => unknown; logThrows?: boolean; caps?: PreDeps['caps'];
  hint?: Record<string, unknown>; push?: Record<string, unknown>;
};

/** Fake dependencies. `st` records every event in order and any property read that the task never uses (`st.forbidden`). */
export function mkDeps(o: FakeOptions = {}) {
  const st = { ev: [] as string[], byRoot: [] as [Ctx, string][], graph: [] as unknown[], gets: [] as string[], sets: [] as [string, unknown][], logs: [] as unknown[][], forbidden: [] as string[] };
  const index = o.index ?? G1();
  const clock = o.clock ?? { t: 1_000_000 };
  let graphCalls = 0;
  let byRootCalls = 0;
  const forbid = <T extends object>(target: T, what: string): T =>
    new Proxy(target, { get: (t, p) => { if (typeof p === 'symbol' || p in t) return Reflect.get(t, p); st.forbidden.push(`${what}.${p}`); return undefined; } });
  const projects = {
    byRoot: async (ctx: Ctx, root: string) => {
      byRootCalls++; st.ev.push('byRoot'); st.byRoot.push([ctx, root]);
      if (o.byRootDelay) await sleep(o.byRootDelay);
      if (o.byRootFails && (o.byRootFails === true || byRootCalls <= o.byRootFails)) throw new Error('db down');
      if (o.noProject) return null;
      const p = ({ 'u-a': 'p1', 'u-b': 'p2', local: 'p0' } as Record<string, string>)[ctx.userId];
      return p && root === ROOTDIR ? { id: p, root } : null;
    },
  };
  const repos = forbid({ projects }, 'repository') as unknown as PreDeps['repos'];
  const graph = forbid({
    get: async (ctx: unknown) => {
      graphCalls++; st.ev.push('graph'); st.graph.push(ctx);
      if (o.graphDelayFirst && graphCalls === 1) await sleep(o.graphDelayFirst);
      if (o.graphFails) throw new Error('db down');
      return { index, loadedAt: 0, epoch: null };
    },
  }, 'graph') as unknown as PreDeps['graph'];
  const store = new Map<string, string>();
  const cache = o.noCache ? undefined : forbid({
    get: async (k: string) => { st.ev.push(`cacheGet:${k.split(':')[0]}`); st.gets.push(k); if (o.cacheGetFails) throw new Error('redis'); return store.has(k) ? JSON.parse(store.get(k) as string) : undefined; },
    set: async (k: string, v: unknown) => { st.ev.push(`cacheSet:${k.split(':')[0]}`); st.sets.push([k, v]); if (o.cacheSetFails) throw new Error('redis'); store.set(k, JSON.stringify(v)); },
  }, 'cache') as unknown as NonNullable<PreDeps['cache']>;
  const config = { graph: { hint: { per_session: 5, quiet_s: 1800, max_nodes: 5, ...o.hint } }, graph_push: { max_chars: 400, note_max: 3, ...o.push } } as unknown as PreDeps['config'];
  const deps: PreDeps = {
    repos, graph, config, ...(cache ? { cache } : {}), now: () => clock.t,
    ctxOf: (o.ctxOf ?? ((req: unknown) => (req as { ctx?: Ctx } | null)?.ctx ?? { userId: 'u-a' })) as (req: unknown) => Ctx,
    log: o.logThrows ? () => { throw new Error('log broke'); } : (m, f) => void st.logs.push([m, f]),
    ...(o.caps ? { caps: o.caps } : {}),
  };
  return { deps, st, clock };
}

export const reply = () => {
  const r: { c?: number; b?: unknown; sent: number; code(n: number): { send(b?: unknown): typeof r } } = {
    sent: 0,
    code(n) { r.c = n; return { send: (b) => { r.sent++; r.b = b; return r; } }; },
  };
  return r;
};

/** One stable route instance (the project memo and the caps live as long as it does). */
export function mkRoute(deps: PreDeps) {
  const route = preRoutes(deps)[0] as ReturnType<typeof preRoutes>[number];
  return {
    post: async (b: unknown, ctx?: Ctx) => {
      const rep = reply();
      await route.handler({ body: b, ...(ctx ? { ctx } : {}) } as Parameters<typeof route.handler>[0], rep);
      return { code: rep.c, body: rep.b as { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | undefined, sent: rep.sent };
    },
  };
}

// ---- gate helpers ---------------------------------------------------------------------------------------------------------

/** Runs `fn` and gives up after `ms`, so closing a pool that waits on a hanging connect cannot hang a test run. */
export const bounded = async (fn: () => Promise<unknown>, ms = 5000): Promise<void> => {
  await Promise.race([fn().catch(() => undefined), sleep(ms)]);
};

/** Loopback endpoints that refuse (a port nothing listens on) and hang (accept, never answer). */
export async function deadPorts(closers: (() => Promise<void>)[]): Promise<{ refused: number; hang: number }> {
  const listen = (s: net.Server): Promise<number> => new Promise((res) => s.listen(0, '127.0.0.1', () => res((s.address() as net.AddressInfo).port)));
  const closed = net.createServer();
  const refused = await listen(closed);
  await new Promise((res) => closed.close(res));
  const sockets = new Set<net.Socket>();
  const hang = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => sockets.delete(s));
    s.resume();
  });
  const hangPort = await listen(hang);
  closers.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((res) => hang.close(res));
  });
  return { refused, hang: hangPort };
}

/** The ledger graph (`NODES`, `EDGES`) written through the repositories, one `replaceSource` per source file. */
export async function writeLedgerGraph(repos: Repositories, ctx: Ctx & { projectId: string }): Promise<void> {
  const files = [...new Set(NODES.map((n) => n.sourceFile as string))];
  for (const sourceFile of files) {
    const nodes = NODES.filter((n) => n.sourceFile === sourceFile);
    const ids = new Set(nodes.map((n) => n.id));
    await repos.graph.replaceSource(ctx, {
      origin: nodes[0]?.kind === 'context' ? 'parser' : 'ast',
      sourceFile,
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, sourceLocation: n.sourceLocation })),
      edges: EDGES.filter((e) => ids.has(e.src)).map((e) => ({ src: e.src, dst: e.dst, relation: e.relation, confidence: e.confidence })),
    });
  }
}
