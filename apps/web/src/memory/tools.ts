/**
 * The four MCP memory tools: `mem_search` (index rows), `mem_timeline` (context around one memory), `mem_get` (full rows) and `save_memory`
 * (spec:111, spec:531-537). Called from: the ctc-web bootstrap, which registers each `McpTool` on `/mcp` and passes the caller's `ctx`.
 * Why: an agent finds a memory in three cheap steps and can save one. Deliberately NOT done: the MCP SDK and transport, auth. Untrusted:
 * every argument and every string read back from the database; a failure becomes an `isError` result, never a throw.
 */
import { applyBands, bandPorts, cleanLine, dayOf, indexRow, rankRecall, recallLimits, type Kind, type Scope } from '@ctc/core/memory';
import { cut, sanitize } from '@ctc/core/sanitize';
import { GLOBAL_MEM_EPOCH } from '@ctc/shared/cache';
import { ModelError } from '@ctc/shared/models';
import type { Ctx } from '@ctc/shared/repositories';
import { MemGetArgs, MemSearchArgs, MemTimelineArgs, SaveMemoryArgs, memoryApiLimits } from '@ctc/shared/schemas/memory';
import { ApiError, errorBody, notFound, parse, toApiError, type McpResult, type McpTool } from '../library/http.ts';
import { callCtx, embedQuery, errClass, memoryView, nowOf, rotateMem, todayOf, type MemoryApiDeps } from './common.ts';

const text = (t: string): McpResult => ({ content: [{ type: 'text', text: t }] });
const reply = (body: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: true });

function failure(deps: MemoryApiDeps, e: unknown): McpResult {
  if (e instanceof ModelError) return reply({ error: { code: 'model_unavailable', message: 'embedder unavailable' } });
  const err = toApiError(e);
  if (err.code === 'internal') deps.log?.('memory tool failed', { error: errClass(e) });
  return reply(errorBody(err));
}

async function search(deps: MemoryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(MemSearchArgs, 'args', rawArgs);
  const ctxP = await callCtx(deps, ctx, args.cwd);
  const query = args.query.slice(0, memoryApiLimits.queryMax);
  const { rrf, half_life_days } = deps.config.memory;
  const legs = await deps.repos.memory.recallLegs(ctxP, { queryText: query, queryVector: await embedQuery(deps, query), perLeg: rrf.per_leg });
  const since = args.since === undefined ? null : Date.parse(`${args.since}T00:00:00Z`);
  const rows = rankRecall(legs, { k: rrf.k, halfLifeDays: half_life_days, now: nowOf(deps) })
    .filter((m) => (args.scope === undefined || m.scope === args.scope) && (args.kind === undefined || m.kind === args.kind) && (since === null || m.createdAt.getTime() >= since))
    .slice(0, args.limit);
  return text(rows.length === 0 ? 'no memories' : rows.map(indexRow).join('\n'));
}

async function timeline(deps: MemoryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(MemTimelineArgs, 'args', rawArgs);
  const ctxP = await callCtx(deps, ctx, args.cwd);
  const got = await deps.repos.memory.timeline(ctxP, { anchorId: args.anchor_id, before: args.before, after: args.after });
  if (!got.memories.some((m) => m.id === args.anchor_id)) throw notFound('anchor not found');
  const items = [
    // judgment: the repository compares with the anchor's time cut to milliseconds, so the anchor can come back as its own neighbour; each id is shown once
    ...got.memories.filter((m, i) => got.memories.findIndex((o) => o.id === m.id) === i).map((m) => ({ at: m.createdAt.getTime(), memory: true, line: indexRow(m) + (m.id === args.anchor_id ? ' · anchor' : '') })),
    ...got.summaries.map((s) => ({
      at: s.createdAt.getTime(),
      memory: false,
      line: `${s.sessionId} · ${dayOf(s.createdAt)} · summary · ${cut(cleanLine(s.request || s.completed || s.nextSteps), recallLimits.indexChars)}`,
    })),
  ].sort((a, b) => a.at - b.at || Number(b.memory) - Number(a.memory));
  return text(items.map((i) => i.line).join('\n'));
}

async function get(deps: MemoryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(MemGetArgs, 'args', rawArgs);
  const ids = [...new Set(args.ids)];
  const found = new Map((await deps.repos.memory.getMany(ctx, ids)).filter((m) => m.deletedAt === null).map((m) => [m.id, m]));
  const rows = ids.flatMap((id) => found.get(id) ?? []);
  if (rows.length > 0) {
    await deps.repos.memory.touch(ctx, rows.map((m) => m.id)).catch((e: unknown) => deps.log?.('memory touch failed', { error: errClass(e) }));
  }
  return text(JSON.stringify(rows.map(memoryView)));
}

async function save(deps: MemoryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(SaveMemoryArgs, 'args', rawArgs);
  const clean = sanitize(args.text).trim();
  if (clean === '') throw new ApiError('invalid', 'text is empty', { path: ['args', 'text'] });
  const ctxP = await callCtx(deps, ctx, args.cwd);
  if (args.scope === 'project' && ctxP.projectId === undefined) throw new ApiError('invalid', 'scope project needs a known project', { path: ['args', 'scope'] });
  const ports = bandPorts({ memory: deps.repos.memory, embed: deps.embed, chat: deps.chat, today: () => todayOf(deps) }, ctxP, { source: { type: 'mcp' } });
  const fact = { kind: args.kind as Kind, scope: args.scope as Scope, text: clean, confidence: 1 };
  const { id, action } = await applyBands(ports, fact, deps.config.memory.bands);
  await rotateMem(deps, ctx, ctxP.projectId);
  if (args.scope === 'global') await rotateMem(deps, ctx, GLOBAL_MEM_EPOCH);
  return text(JSON.stringify({ id, action }));
}

/** Exactly `mem_search`, `mem_timeline`, `mem_get` and `save_memory`; names are frozen (spec:111). */
export function memoryTools(deps: MemoryApiDeps): McpTool[] {
  const wrap = (run: (d: MemoryApiDeps, c: Ctx, a: unknown) => Promise<McpResult>) => async (ctx: Ctx, args: unknown): Promise<McpResult> => {
    try {
      return await run(deps, ctx, args);
    } catch (e) {
      return failure(deps, e);
    }
  };
  return [
    {
      name: 'mem_search',
      description:
        'Search long-term memories (step 1 of 3). Returns one index row per hit, best first: id · date · kind · first 80 chars. Optional scope, kind, since (YYYY-MM-DD), limit and cwd (absolute project path). Then call mem_timeline or mem_get with an id.',
      inputSchema: MemSearchArgs,
      call: wrap(search),
    },
    {
      name: 'mem_timeline',
      description: 'Context around one memory (step 2 of 3): up to 10 memories and session summaries before and after the anchor, oldest first, as index rows.',
      inputSchema: MemTimelineArgs,
      call: wrap(timeline),
    },
    {
      name: 'mem_get',
      description: 'Full rows of up to 20 memories by id (step 3 of 3) as JSON. Counts as a use of each memory.',
      inputSchema: MemGetArgs,
      call: wrap(get),
    },
    {
      name: 'save_memory',
      description:
        'Save one fact (at most 300 chars) with kind preference, convention, fact or skill_outcome and scope global or project (project needs cwd, an absolute project path). Merges with a similar memory. Returns {id, action} with action NOOP, UPDATE, SUPERSEDE or ADD.',
      inputSchema: SaveMemoryArgs,
      call: wrap(save),
    },
  ];
}
