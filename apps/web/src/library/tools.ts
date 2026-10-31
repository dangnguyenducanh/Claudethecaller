/**
 * The two MCP tools of the library: `get_capability` and `load_capability_resource` (spec:423-425).
 * Called from: the ctc-web bootstrap, which registers each `McpTool` on the MCP server at `/mcp` and passes the caller's `ctx`.
 * Why: an agent reads one version of a skill, then loads its files, and the files never come from another version.
 * Deliberately NOT done: the MCP SDK and transport, auth. Untrusted: every argument; a failure becomes an `isError` result, never a throw.
 */
import { GetCapabilityArgs, LoadResourceArgs } from '@ctc/shared/schemas/library';
import type { Ctx } from '@ctc/shared/repositories';
import { errorBody, notFound, parse, toApiError, type LibraryApiDeps, type McpResult, type McpTool } from './http.ts';
import { manifestAndBody, resolveCapability } from './read.ts';
import { servedFrom } from './served.ts';

const text = (t: string): McpResult => ({ content: [{ type: 'text', text: t }] });
const failure = (e: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(errorBody(toApiError(e))) }], isError: true });
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function getCapability(deps: LibraryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(GetCapabilityArgs, 'args', rawArgs);
  const cap = await resolveCapability(deps, ctx, args.name);
  const versions = await deps.repos.library.listVersions(ctx, cap.id);
  let picked = versions.find((v) => v.version === args.version);
  if (args.version === undefined) {
    if (args.label !== undefined) {
      const label = args.label;
      picked = versions.filter((v) => v.labels.includes(label)).sort((a, b) => b.version - a.version)[0];
    } else {
      // judgment: an explicit label or version reads past a block override (a deliberate read); the default read honours it.
      const served = await servedFrom(deps, ctx, cap.id, versions);
      if (served === null) throw notFound('not served for this project');
      picked = versions.find((v) => v.version === served);
    }
  }
  if (!picked) throw notFound('version not found');
  const { manifest, body } = await manifestAndBody(deps, ctx, cap.kind, picked.id);
  const files = manifest.map((m) => ({ path: m.path, size: m.size })).sort((a, b) => cmp(a.path, b.path));
  return text(JSON.stringify({ version_id: picked.id, version: picked.version, labels: [...picked.labels], frontmatter: picked.frontmatter ?? {}, body, files }));
}

async function loadResource(deps: LibraryApiDeps, ctx: Ctx, rawArgs: unknown): Promise<McpResult> {
  const args = parse(LoadResourceArgs, 'args', rawArgs);
  const content = await deps.repos.library.getBlob(ctx, args.version_id, args.path);
  if (content === null) throw notFound('resource not found');
  return text(content);
}

/** Exactly `get_capability` and `load_capability_resource`; names are frozen (spec:166). */
export function libraryTools(deps: LibraryApiDeps): McpTool[] {
  const wrap = (run: (d: LibraryApiDeps, c: Ctx, a: unknown) => Promise<McpResult>) => async (ctx: Ctx, args: unknown): Promise<McpResult> => {
    try {
      return await run(deps, ctx, args);
    } catch (e) {
      return failure(e);
    }
  };
  return [
    {
      name: 'get_capability',
      description:
        'Read one skill, agent, command or workflow by name (`name` or `namespace:name`). Returns the served version by default, or the version with a given label or number: version_id, version, labels, frontmatter, body and the file list. Load a listed file with load_capability_resource.',
      inputSchema: GetCapabilityArgs,
      call: wrap(getCapability),
    },
    {
      name: 'load_capability_resource',
      description: 'Load one file of the exact version that get_capability returned (version_id and a path from its file list). Never mixes versions.',
      inputSchema: LoadResourceArgs,
      call: wrap(loadResource),
    },
  ];
}
