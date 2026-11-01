/**
 * Read helpers of the library surface: the main-file body of a version and the name lookup of `get_capability` (D11, D13).
 * Called from: routes.ts, tools.ts. Why: the dashboard version page and the MCP tool must show the same body and the same file list.
 * Deliberately NOT done: writes, caching. Untrusted: manifest paths and blob contents read from the database (returned, never executed).
 */
import { bodyOf, isName, mainPathOf } from '@ctc/core/library';
import { libraryApiLimits } from '@ctc/shared/schemas/library';
import type { Ctx } from '@ctc/shared/repositories';
import { ApiError, notFound, type Capability, type LibraryApiDeps } from './http.ts';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER = ['skill', 'agent', 'command', 'workflow'];

/** The manifest of a version and the body of its main file (`''` when there is no main file or its blob is missing). */
export async function manifestAndBody(deps: LibraryApiDeps, ctx: Ctx, kind: string, versionId: string) {
  const manifest = await deps.repos.library.manifest(ctx, versionId);
  const mainPath = mainPathOf(manifest.map((m) => m.path));
  const content = mainPath === null ? null : await deps.repos.library.getBlob(ctx, versionId, mainPath);
  return { manifest, body: mainPath === null || content === null ? '' : bodyOf(kind, mainPath, content) };
}

/**
 * Picks the capability for an MCP `name` (D11): `ns:bare` or `bare`; the `user` namespace wins, else a single namespace, else `ambiguous`;
 * within the namespace the first kind of skill, agent, command, workflow.
 */
export async function resolveCapability(deps: LibraryApiDeps, ctx: Ctx, name: string): Promise<Capability> {
  const colon = name.indexOf(':');
  const ns = colon === -1 ? undefined : name.slice(0, colon);
  const bare = colon === -1 ? name : name.slice(colon + 1);
  if (!isName(bare)) throw notFound('capability not found');
  const all = await deps.repos.library.listByName(ctx, bare);
  const named = ns === undefined ? all : all.filter((c) => c.namespace === ns);
  if (named.length === 0) throw notFound('capability not found');
  const spaces = [...new Set(named.map((c) => c.namespace))];
  let space: string | undefined;
  if (spaces.includes('user')) space = 'user';
  else if (spaces.length === 1) space = spaces[0];
  else {
    const candidates = named
      .map((c) => ({ name: `${c.namespace}:${c.name}`, kind: c.kind }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.kind, b.kind))
      .slice(0, libraryApiLimits.candidatesMax);
    throw new ApiError('ambiguous', 'name matches several namespaces; qualify it as namespace:name', { candidates });
  }
  const inSpace = named.filter((c) => c.namespace === space);
  for (const kind of KIND_ORDER) {
    const hit = inSpace.find((c) => c.kind === kind);
    if (hit) return hit;
  }
  // judgment: a kind outside the four known ones is still readable; take the first by kind order of the database.
  const [first] = inSpace;
  if (!first) throw notFound('capability not found');
  return first;
}
