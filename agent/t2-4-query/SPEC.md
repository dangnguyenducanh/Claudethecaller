# Task: build the F1 graph query layer: pure query algorithms (name resolution, search, explain, path, affected, neighbors) in `packages/core`, the RAM graph store, the five MCP tools `graph_search`, `graph_explain`, `graph_path`, `graph_affected`, `graph_neighbors`, and the `/api/graph` routes (query, stats, build, edge review).

Callers (built later or in parallel): the ctc-web bootstrap mounts `graphRoutes(deps)` and `graphTools(deps)` and feeds `store.onInval` from `ctc:inval`; Claude Code agents call the MCP tools instead of grepping; the dashboard calls `/api/graph/*`; T5.1 and T5.2 reuse the index, the seed functions and the store for the prompt line and the note before a tool. They read what is merged: `repos.graph` and `repos.projects` (T1.3), `cache.epoch` (T1.4), the graph rows written by T2.1/T2.2/T2.3, `sanitize`, the model `Embed` type, and the `Route` / `McpTool` / `ApiError` plumbing of `apps/web/src/library/http.ts`. Untrusted: every tool argument and route input, and every string read back from the database (labels, paths, locations) and from files (excerpts). The gate is the Vitest test `graph.query` (spec §2.11, §7): 30 fixed questions on this repository answered from a graph built by the real T2.x pipeline match the recorded baseline in at least 27 of 30 (rules in DECISIONS.md D22).

Public names (TypeScript strict; exact shapes in DECISIONS.md D9):

    packages/core/src/graph/query    (`@ctc/core/graph/query`, pure):
      queryLimits, QueryError, buildIndex, resolveName, lexicalSeeds, denseSeeds, walkFrom, searchGraph, explainNode, findPath, affectedBy,
      neighborsOf, nodeRef, renderSearch, renderExplain, renderPath, renderAffected, renderNeighbors; types GNode, GEdge, GraphIndex, NodeRef, Hit,
      SearchResult, ExplainResult, PathResult, AffectedResult, NeighborsResult, Seed
    packages/shared/src/schemas/graph (`@ctc/shared/schemas/graph`, Zod only):
      graphApiLimits, GraphSearchArgs, GraphExplainArgs, GraphPathArgs, GraphAffectedArgs, GraphNeighborsArgs,
      GraphSearchQuery, GraphExplainQuery, GraphPathQuery, GraphAffectedQuery, GraphNeighborsQuery, GraphStatsQuery, GraphBuildBody, GraphEdgeBody
    apps/web/src/graph               graphRoutes(deps): Route[], graphTools(deps): McpTool[], createGraphStore(o): GraphStore,
                                     readExcerpt(root, node, readText?), types GraphApiDeps, GraphStore, LoadedGraph
    fixtures/py-baseline/graph-answers.json   byte-for-byte copy of agent/t2-4-query/baseline/py-graph-answers.json (the recorded Python answers)

## How to work
1. `agent/t2-4-query/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t2-4-query/PROCESS.md` is the order of work.
3. Change only these paths (source, `*.test.ts`):
   - `packages/core/src/graph/query/`
   - `packages/shared/src/schemas/graph/`
   - `apps/web/src/graph/`
   - `fixtures/py-baseline/graph-answers.json` (copy of the baseline, nothing else in that directory)
   - new `*.test.ts` files anywhere.
   No new dependency, no `package.json`, lockfile or ESLint config change (`zod` is in `@ctc/shared`; `yaml`, `web-tree-sitter` are not needed). Do not edit any existing `index.ts` (`packages/core/src/graph/index.ts`, `packages/core/src/index.ts`, `apps/worker/src/graph/index.ts`, `apps/web/src/index.ts`): T2.1/T2.2 tests pin their export lists.
   Do not edit `apps/web/src/library/` (import `Route`, `McpTool`, `ApiError`, `parse`, `toApiError`, `errorBody` from `../library/http.ts`), `apps/worker`, the repositories, `packages/shared/src/cache`, `queues`, `models`, `env`, `packages/core/src/sanitize`, or the migrations.
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`), the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`, needed by the project suites only) and the shared TEI embedder `127.0.0.1:18300` are running (use them, never restart them).
   Tests create their own schema `ctc_t24_<random>` with `migrate({url, schema})` from `@ctc/shared/repositories/admin`, open it with `createDb({url, schema})` + `createRepositories(db)`, and drop it in `afterAll`. Pure tests use fakes (hand-made graphs, fake `repos`, fake `embed`). Never touch `~/.claude`, `~/.claudethecaller`, port 18310 or any other service.

Test naming (the self-check's `--fast` skips slow files by name): the gate test is `apps/web/src/graph/graph.query.int.test.ts` with a top-level `describe('graph.query', …)` and the test named exactly as in D22; every test that needs Postgres or TEI is `*.int.test.ts`; pure tests are `*.test.ts`.

## Done
`python3 agent/t2-4-query/selfcheck.py` prints `SELFCHECK: DONE`. It runs the gate test `graph.query` (spec §2.11, §7 F1), the module tests, `checks.mjs` (which re-evaluates the 30 questions independently), ESLint on the module, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` (which keeps the T2.1/T2.2/T2.3 gates, `tenancy` and the other earlier gates green), the baseline copy check and the scope check.
