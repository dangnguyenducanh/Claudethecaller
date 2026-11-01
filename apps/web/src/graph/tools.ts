/**
 * The five MCP graph tools: `graph_search`, `graph_explain`, `graph_path`, `graph_affected`, `graph_neighbors` (spec:111, spec:325-329).
 * Called from: the ctc-web bootstrap, which registers each `McpTool` on `/mcp` and passes the caller's `ctx`. Why: an agent asks the graph instead
 * of grepping. Deliberately NOT done: the MCP SDK and transport, auth, any write. Untrusted: every argument and every string read back from the
 * database; a failure becomes an `isError` result, never a throw.
 */
import {
  renderAffected, renderExplain, renderNeighbors, renderPath, renderSearch,
} from '@ctc/core/graph/query';
import type { Ctx } from '@ctc/shared/repositories';
import { GraphAffectedArgs, GraphExplainArgs, GraphNeighborsArgs, GraphPathArgs, GraphSearchArgs } from '@ctc/shared/schemas/graph';
import { errorBody, notFound, parse, type McpResult, type McpTool } from '../library/http.ts';
import {
  configOf, doAffected, doExplain, doNeighbors, doPath, doSearch, errClass, failure, type GraphApiDeps, type GraphConfig, type ProjectCtx,
} from './common.ts';

type Schema<A> = Parameters<typeof parse<A>>[0];
const text = (t: string): McpResult => ({ content: [{ type: 'text', text: t }] });
const error = (body: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: true });

/** D18: `ctx.projectId`, else the project of an absolute `cwd` (trailing slashes removed), else `not_found`. */
async function projectOf(deps: GraphApiDeps, ctx: Ctx, cwd: string | undefined): Promise<ProjectCtx> {
  if (ctx.projectId !== undefined) return { ...ctx, projectId: ctx.projectId };
  if (typeof cwd === 'string' && cwd.startsWith('/')) {
    const p = await deps.repos.projects.byRoot(ctx, cwd.replace(/\/+$/, '') || '/');
    if (p) return { ...ctx, projectId: p.id };
  }
  throw notFound('project not found');
}

/** Exactly the five tools, in this order; names are frozen (spec:166). */
export function graphTools(deps: GraphApiDeps): McpTool[] {
  const cfg = configOf(deps);
  const tool = <A extends { cwd?: string | undefined }>(
    name: string,
    description: string,
    inputSchema: Schema<A>,
    run: (c: ProjectCtx, a: A, cfg: GraphConfig) => Promise<string>,
  ): McpTool => ({
    name,
    description,
    inputSchema,
    async call(ctx, rawArgs) {
      let projectId: string | null = null;
      try {
        const args = parse(inputSchema, 'args', rawArgs);
        const pc = await projectOf(deps, ctx, args.cwd);
        projectId = pc.projectId;
        return text(await run(pc, args, cfg));
      } catch (e) {
        return error(errorBody(failure(deps, e)));
      } finally {
        try {
          deps.onToolCall?.({ userId: ctx.userId, projectId, tool: name });
        } catch (e) {
          deps.log?.('graph onToolCall failed', { error: errClass(e) });
        }
      }
    },
  });
  const budget = { budgetTokens: cfg.budgetTokens };
  return [
    tool(
      'graph_search',
      'Search the project graph (code, specs, tasks, decisions, skills) by words. Returns the best matches first as lines `seed|hopN score label [type] file:line (id)`. Optional types, limit (max 50) and cwd (absolute project path).',
      GraphSearchArgs,
      async (c, a, g) => renderSearch(await doSearch(deps, g, c, a), budget),
    ),
    tool(
      'graph_explain',
      'One graph node by id, label, `path::symbol` or file path: its source excerpt (at most 40 lines) and its edges grouped by relation. Optional cwd (absolute project path).',
      GraphExplainArgs,
      async (c, a) => renderExplain(await doExplain(deps, c, a.name)),
    ),
    tool(
      'graph_path',
      'Shortest path between two graph nodes, one hop per line. Optional max_hops (1 to 8, default 8), directed (default true) and cwd (absolute project path).',
      GraphPathArgs,
      async (c, a) => renderPath(await doPath(deps, c, a)),
    ),
    tool(
      'graph_affected',
      'The nodes that depend on a node (callers, importers, containers, implementers) up to depth 3, grouped by type. Optional depth and cwd (absolute project path).',
      GraphAffectedArgs,
      async (c, a, g) => renderAffected(await doAffected(deps, g, c, a)),
    ),
    tool(
      'graph_neighbors',
      'Nodes adjacent to a node, one per line `direction relation confidence node`. Optional relation, direction (in, out, both), limit (max 200, default 50) and cwd (absolute project path).',
      GraphNeighborsArgs,
      async (c, a) => renderNeighbors(await doNeighbors(deps, c, a)),
    ),
  ];
}
