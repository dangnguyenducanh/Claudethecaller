/**
 * Zod schemas of F1 graph queries: the five MCP tool arguments and the `/api/graph` query strings and bodies. Called from: apps/web/src/graph
 * (handlers validate with them). Why: one place defines which request values are valid. Deliberately NOT done: I/O, name resolution, checking that
 * `cwd` is an absolute path (the tool ignores anything else), the relation name format (core checks it). Every value that reaches these schemas is untrusted.
 */
import { z } from 'zod';

/**
 * `searchMax`, `depthMax`, `maxHopsMax` and `neighborsMax` repeat `queryLimits` of @ctc/core/graph/query (`@ctc/shared` cannot import `@ctc/core`; keep them
 * equal): FROM-SPEC spec:325-331. `cwdMax` is Linux PATH_MAX. `queryHard`, `nameMax`, `typesMax`, `typeMax`, `relationMax`, `idMax`: chosen by judgment.
 */
export const graphApiLimits = {
  searchDefault: 10,
  searchMax: 50,
  depthMax: 3,
  maxHopsMax: 8,
  neighborsMax: 200,
  queryHard: 20000,
  nameMax: 256,
  typesMax: 20,
  typeMax: 40,
  relationMax: 32,
  idMax: 1024,
  cwdMax: 4096,
};
const L = graphApiLimits;

const cwd = z.string().min(1).max(L.cwdMax);
const text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim() !== '', 'must not be blank');
const query = text(L.queryHard);
const name = text(L.nameMax);
const typeName = z.string().min(1).max(L.typeMax);
const projectId = z.string().min(1).max(L.idMax);
/** An integer, or a digit string (query strings arrive as text), in `lo..hi`. */
const bounded = (lo: number, hi: number, what: string) =>
  z
    .union([z.number().int(), z.string().regex(/^[0-9]+$/)])
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= lo && n <= hi, `${what} must be an integer from ${lo} to ${hi}`);
const flag = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
/** A comma-separated list of type names (query strings carry no arrays). */
const typeList = z
  .string()
  .transform((s) => s.split(',').map((t) => t.trim()).filter((t) => t !== ''))
  .pipe(z.array(typeName).max(L.typesMax));
const direction = z.enum(['in', 'out', 'both']);
const relation = z.string().min(1).max(L.relationMax);

const limit = z.number().int().min(1).max(L.searchMax).default(L.searchDefault);
const depth = z.number().int().min(1).max(L.depthMax);
const maxHops = z.number().int().min(1).max(L.maxHopsMax).default(L.maxHopsMax);
const nbLimit = z.number().int().min(1).max(L.neighborsMax);

export const GraphSearchArgs = z.strictObject({ query, types: z.array(typeName).max(L.typesMax).optional(), limit, cwd: cwd.optional() });
export const GraphExplainArgs = z.strictObject({ name, cwd: cwd.optional() });
export const GraphPathArgs = z.strictObject({ from: name, to: name, max_hops: maxHops, directed: z.boolean().default(true), cwd: cwd.optional() });
export const GraphAffectedArgs = z.strictObject({ name, depth: depth.optional(), cwd: cwd.optional() });
export const GraphNeighborsArgs = z.strictObject({ name, relation: relation.optional(), direction: direction.default('both'), limit: nbLimit.optional(), cwd: cwd.optional() });

export const GraphSearchQuery = z.strictObject({
  project_id: projectId,
  query,
  types: typeList.optional(),
  limit: bounded(1, L.searchMax, 'limit').default(L.searchDefault),
});
export const GraphExplainQuery = z.strictObject({ project_id: projectId, name });
export const GraphPathQuery = z.strictObject({
  project_id: projectId,
  from: name,
  to: name,
  max_hops: bounded(1, L.maxHopsMax, 'max_hops').default(L.maxHopsMax),
  directed: flag.default(true),
});
export const GraphAffectedQuery = z.strictObject({ project_id: projectId, name, depth: bounded(1, L.depthMax, 'depth').optional() });
export const GraphNeighborsQuery = z.strictObject({
  project_id: projectId,
  name,
  relation: relation.optional(),
  direction: direction.default('both'),
  limit: bounded(1, L.neighborsMax, 'limit').optional(),
});
export const GraphStatsQuery = z.strictObject({ project_id: projectId });
export const GraphBuildBody = z.strictObject({ project_id: projectId, force: z.boolean().optional() });
export const GraphEdgeBody = z.strictObject({
  project_id: projectId,
  src: z.string().min(1).max(L.idMax),
  dst: z.string().min(1).max(L.idMax),
  relation,
  confidence: z.enum(['CONFIRMED', 'DROPPED']),
});
