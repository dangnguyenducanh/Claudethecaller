/**
 * The F1 pre-tool hook: `POST /v1/hook/pre` (Claude Code PreToolUse, `curl -m 0.05`). A Read/Edit/Write/MultiEdit of a file gets a one-line NOTE
 * (tasks that implement it, decisions that decide it, top callers); a Grep, Glob or Bash grep/rg/find gets a one-line HINT (graph nodes that match
 * the search words), with per-session caps (spec:316-319). Everything is answered from the RAM graph store: no TEI, no Redis write besides the
 * `proj:` entry `projectOf` keeps, no Postgres write.
 * Called from: the ctc-web bootstrap, which mounts `preRoutes(deps)` with the store it already holds and wires the caps to the graph tools:
 *   `const caps = createSessionCaps(); graphTools({ ..., onToolCall: (i) => caps.markGraphCall(i) }); preRoutes({ ..., caps })`;
 * T7.1 points `.claude/settings.json` at the route. Why: the model sees what the graph knows before it opens a file or greps.
 * Deliberately NOT done: Fastify, auth, rate limits, the `ctc:inval` subscription, de-duplicating a note already shown, an ancestor walk from a
 * sub-directory `cwd`, `NotebookEdit` and other tools, a quiet window or a count for notes, persisting counters, blocking a tool (the reply carries
 * `additionalContext` only). Untrusted: the whole body (cwd, tool_name, tool_input, session_id) and every label, path and id read from the graph.
 * The route never throws: any failure, a bad body or an answer later than the budget is an empty `204`. `deps.log` gets class names only.
 */
import { fileNote, hintLine, relInside, searchTerms } from '@ctc/core/graph/note';
import type { Config } from '@ctc/shared/env';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { PreBody, preApiLimits } from '@ctc/shared/schemas/pre';
import type { GraphStore } from '../graph/index.ts';
import type { Route } from '../library/http.ts';
import { errClass, isAbs, projectOf, rootOf } from '../memory/common.ts';

export type PreResult = {
  text: string;
  kind: 'note' | 'hint' | 'none';
  reason: 'ok' | 'tool' | 'input' | 'project' | 'outside' | 'quiet' | 'capped' | 'nomatch' | 'error';
  commit(): boolean;
  ms: number;
};
export type Pre = {
  run(ctx: Ctx, input: { cwd: unknown; tool_name: unknown; tool_input?: unknown; session_id?: unknown }, opts?: { signal?: AbortSignal }): Promise<PreResult>;
};
export type SessionCaps = {
  blocked(s: { userId: string; projectId: string; sessionId: string }, o: { perSession: number; quietS: number }): 'quiet' | 'capped' | null;
  charge(s: { userId: string; sessionId: string }, o: { perSession: number }): boolean;
  markGraphCall(info: { userId: string; projectId?: string | null; sessionId?: string | null; tool: string }): void;
  size(): number;
};
export type PreDeps = {
  repos: Pick<Repositories, 'projects'>;
  config: Pick<Config, 'graph' | 'graph_push'>;
  graph: Pick<GraphStore, 'get'>;
  cache?: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttlSeconds: number): Promise<void> };
  caps?: SessionCaps;
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
  now?(): number;
};

/**
 * Read at call time, so a test may change a field and restore it. `hookBudgetMs` 40: FROM-SPEC (spec:316). All others chosen by judgment:
 * the project memo keeps the hot path RAM only (30 s, 256 keys), a session is dropped after 24 h idle and at most 1,000 are held.
 */
export const preLimits = { hookBudgetMs: 40, projectMemoMs: 30_000, projectMemoMax: 256, sessionMax: 1000, sessionIdleMs: 86_400_000 };

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'Bash']);
const SEP = '\u0000';

/** Evicts the oldest inserted entries of `m` until at most `max` remain. */
function bound<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) m.delete(m.keys().next().value as K);
}

/**
 * RAM-only session state (D17): hints SENT per session, and the quiet marks that `graph_*` MCP calls leave (per session, else per project, else per
 * user). Only `charge` creates a session counter. A restart forgets everything. Never throws.
 */
export function createSessionCaps(o: { now?(): number } = {}): SessionCaps {
  const now = (): number => o.now?.() ?? Date.now();
  const sessions = new Map<string, { count: number; touched: number }>();
  const marks = new Map<string, number>();
  const live = (key: string): { count: number; touched: number } | undefined => {
    const s = sessions.get(key);
    return s && now() - s.touched <= preLimits.sessionIdleMs ? s : undefined;
  };
  const sessionKey = (userId: string, sessionId: string): string => `${userId}${SEP}${sessionId}`;
  return {
    blocked(s, cfg) {
      try {
        const t = Math.max(
          marks.get(`s${SEP}${sessionKey(s.userId, s.sessionId)}`) ?? -Infinity,
          marks.get(`p${SEP}${s.userId}${SEP}${s.projectId}`) ?? -Infinity,
          marks.get(`u${SEP}${s.userId}`) ?? -Infinity,
        );
        if (now() - t < cfg.quietS * 1000) return 'quiet';
        return (live(sessionKey(s.userId, s.sessionId))?.count ?? 0) >= cfg.perSession ? 'capped' : null;
      } catch {
        return null;
      }
    },
    charge(s, cfg) {
      try {
        const key = sessionKey(s.userId, s.sessionId);
        const count = live(key)?.count ?? 0;
        if (count >= cfg.perSession) return false;
        sessions.delete(key);
        sessions.set(key, { count: count + 1, touched: now() });
        bound(sessions, preLimits.sessionMax);
        return true;
      } catch {
        return false;
      }
    },
    markGraphCall(info) {
      try {
        if (typeof info?.tool !== 'string' || !info.tool.startsWith('graph_') || typeof info.userId !== 'string' || info.userId === '') return;
        const key =
          typeof info.sessionId === 'string' && info.sessionId !== ''
            ? `s${SEP}${sessionKey(info.userId, info.sessionId)}`
            : typeof info.projectId === 'string' && info.projectId !== ''
              ? `p${SEP}${info.userId}${SEP}${info.projectId}`
              : `u${SEP}${info.userId}`;
        marks.delete(key);
        marks.set(key, now());
        // judgment: one bound for all three mark kinds; the oldest mark is the first to have expired anyway
        bound(marks, preLimits.sessionMax * 3);
      } catch {
        // judgment: a mark that cannot be stored only means a hint may come during the quiet window
      }
    },
    size: () => sessions.size,
  };
}

const posInt = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : dflt);
const userOf = (ctx: unknown): Ctx => {
  const id = (ctx as { userId?: unknown } | null)?.userId;
  return { userId: typeof id === 'string' && id !== '' ? id : 'local' };
};
const round1 = (x: number): number => Math.round(x * 10) / 10;

type Project = { id: string; root: string };

export function createPre(deps: PreDeps): Pre {
  const now = (): number => deps.now?.() ?? Date.now();
  const caps = deps.caps ?? createSessionCaps(deps.now ? { now: deps.now } : {});
  const memo = new Map<string, { value: Promise<Project | null>; settledAt: number | null }>();

  function log(message: string, e: unknown): void {
    try {
      deps.log?.(message, { error: errClass(e) });
    } catch {
      // judgment: a failing logger never fails a hook
    }
  }

  /** The project of `root`, remembered in RAM (hits and misses) for `projectMemoMs`; concurrent lookups share one promise; a rejection is forgotten at once. */
  function lookup(ctx: Ctx, root: string): Promise<Project | null> {
    const key = `${ctx.userId}${SEP}${root}`;
    const hit = memo.get(key);
    if (hit && (hit.settledAt === null || now() - hit.settledAt < preLimits.projectMemoMs)) return hit.value;
    const entry: { value: Promise<Project | null>; settledAt: number | null } = { value: Promise.resolve(null), settledAt: null };
    entry.value = projectOf(deps, ctx, root).then(
      (p) => {
        entry.settledAt = now();
        return p;
      },
      (e: unknown) => {
        if (memo.get(key) === entry) memo.delete(key);
        throw e;
      },
    );
    memo.delete(key);
    memo.set(key, entry);
    bound(memo, preLimits.projectMemoMax);
    return entry.value;
  }

  async function run(ctxIn: Ctx, input: unknown): Promise<PreResult> {
    const t0 = performance.now();
    const done = (kind: PreResult['kind'], reason: PreResult['reason'], text = '', commit: () => boolean = () => true): PreResult => ({
      text, kind, reason, commit, ms: round1(performance.now() - t0),
    });
    const none = (reason: PreResult['reason']): PreResult => done('none', reason);
    try {
      const ctx = userOf(ctxIn);
      const body = PreBody.safeParse(input);
      if (!body.success || !isAbs(body.data.cwd)) return none('input');
      const tool = body.data.tool_name;
      const isFile = FILE_TOOLS.has(tool);
      if (!isFile && !SEARCH_TOOLS.has(tool)) return none('tool');
      const raw = (input as { session_id?: unknown }).session_id;
      const sessionId = typeof raw === 'string' && raw.length <= preApiLimits.sessionIdMax ? raw : '';
      const root = rootOf(body.data.cwd);

      let rel = '';
      let terms: string[] = [];
      if (isFile) {
        const fp = body.data.tool_input['file_path'];
        if (typeof fp !== 'string' || fp === '' || fp.includes('\0')) return none('input');
        const r = relInside(root, fp);
        if (r === null) return none('outside');
        rel = r;
      } else {
        const found = searchTerms(tool, body.data.tool_input, { root });
        if (found.outside) return none('outside');
        if (found.terms.length === 0) return none('nomatch');
        terms = found.terms;
      }

      let project: Project | null;
      try {
        project = await lookup(ctx, root);
      } catch (e) {
        log('pre project lookup failed', e);
        return none('error');
      }
      if (!project) return none('project');

      const perSession = posInt(deps.config.graph.hint.per_session, 5);
      if (!isFile) {
        const blocked = caps.blocked({ userId: ctx.userId, projectId: project.id, sessionId }, { perSession, quietS: posInt(deps.config.graph.hint.quiet_s, 1800) });
        if (blocked !== null) return none(blocked);
      }

      const loaded = await deps.graph.get({ userId: ctx.userId, projectId: project.id });
      const maxChars = posInt(deps.config.graph_push.max_chars, 400);
      const text = isFile
        ? fileNote(loaded.index, rel, { max: posInt(deps.config.graph_push.note_max, 3), maxChars })
        : hintLine(loaded.index, terms, { maxNodes: posInt(deps.config.graph.hint.max_nodes, 5), maxChars });
      if (text === '') return none('nomatch');
      return isFile ? done('note', 'ok', text) : done('hint', 'ok', text, () => caps.charge({ userId: ctx.userId, sessionId }, { perSession }));
    } catch (e) {
      log('pre failed', e);
      return none('error');
    }
  }

  return { run };
}

const TIMED_OUT = Symbol('timed out');

/** `POST /v1/hook/pre`. */
export function preRoutes(deps: PreDeps): Route[] {
  const pre = createPre(deps);
  const ctxFor = (req: unknown): Ctx => {
    try {
      return userOf(deps.ctxOf?.(req));
    } catch {
      return { userId: 'local' };
    }
  };
  const route: Route = {
    method: 'POST',
    url: '/v1/hook/pre',
    async handler(req, reply) {
      let timer: NodeJS.Timeout | undefined;
      let text = '';
      try {
        // judgment: when the timer wins the work keeps running (it warms the store and the project memo) and its result, with its `commit`, is dropped
        const work = pre.run(ctxFor(req), req?.body as { cwd: unknown; tool_name: unknown }).catch(() => null);
        const budget = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), preLimits.hookBudgetMs);
        });
        const r = await Promise.race([work, budget]);
        if (r !== TIMED_OUT && r !== null && r.kind !== 'none' && r.commit()) text = r.text;
      } catch (e) {
        try {
          deps.log?.('pre hook failed', { error: errClass(e) });
        } catch {
          // judgment: a failing logger never fails a hook
        }
      } finally {
        clearTimeout(timer);
      }
      return text === ''
        ? reply.code(204).send()
        : reply.code(200).send({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
    },
  };
  return [route];
}
