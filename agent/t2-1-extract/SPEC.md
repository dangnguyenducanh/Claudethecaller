# Task: build `packages/core/src/graph` (ids, web-tree-sitter extract, markdown): one source file in, graphify-compatible graph nodes, `contains` edges and raw references out.

Callers (built later): the `graph` queue jobs in `apps/worker` (T2.2) walk a repo, call `extractFile` once per file, resolve the raw imports and refs across files, and store each file through `repos.graph.replaceSource` (`packages/shared/src/repositories/graph.ts`); the context parsers (T2.3) and the query tools (T2.4) reuse the ids. Node ids must equal graphify 0.9.93's (with a `code:`/`doc:` prefix) so today's graph answers and the later `graph.query` gate stay comparable. File content is untrusted (any repo); the path comes from the walk but is validated.

Public names (`@ctc/core/graph`, entry `packages/core/src/graph/index.ts`; exact shapes in DECISIONS D3, D9, D10, D18-D20, D22):

    normalizeId(s: string): string                 makeId(...parts: string[]): string        fileStem(relPath: string): string
    langOf(relPath: string): Lang | null           loadGrammars(): Promise<Grammars>         cleanLabel(s: string): string
    extractFile(input: { path: string; content: string }, grammars: Grammars): ExtractResult      // never throws
    limits (mutable object, read at call time)     EXTRACTOR_VERSION = 'ctc-ts-1'            class GrammarError { code: 'grammar_missing' }
    types: Lang, NodeType, Grammars, ExtractInput, ExtractResult, ExtractedNode, ExtractedEdge, RawImport, RawRef, RawMention, ExtractErrorCode

## How to work
1. `agent/t2-1-extract/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t2-1-extract/PROCESS.md` is the order of work.
3. Change only `packages/core/src/graph/` (sources, `*.test.ts`, `__fixtures__/`), plus the dependency lines D22 allows in `packages/core/package.json` and the resulting `pnpm-lock.yaml`. Nothing else: not `packages/core/src/index.ts`, not other packages, not the root, not Python.
4. Install the six pinned packages yourself (the npm registry is allowed for this, FROM-OWNER O11):
   `pnpm --filter @ctc/core add --save-exact web-tree-sitter@0.25.10 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 tree-sitter-python@0.25.0 tree-sitter-bash@0.25.1 tree-sitter-json@0.24.8`
   (pnpm warns that their native build scripts were ignored and that the `tree-sitter` peer is missing; both are expected, the WASM files are used.)
5. The golden graphify output is in `agent/t2-1-extract/golden/` (read only). Copy it as D21 says; never edit the copies.

Gate test (spec §7, F1): `graph.ids`, the Vitest file `packages/core/src/graph/graph.ids.test.ts` with `describe('graph.ids', …)` (D21). Other unit tests go in `packages/core/src/graph/*.test.ts`, at least one per decision id.

The project test suites need the scratch services; `selfcheck.py` sets these when they are unset: `CTC_SCRATCH_PG_URL`/`CTC_TEST_ADMIN_URL` = the scratch Postgres `127.0.0.1:18304`, `CTC_SCRATCH_REDIS_URL` = `redis://127.0.0.1:18395`. One `packages/shared` test (`schema-assumptions … every column the repositories use exists`) already fails on HEAD; the self-check lists it as pre-existing and does not count it.

## Done
`python3 agent/t2-1-extract/selfcheck.py` prints `SELFCHECK: DONE` (`--fast` for a quick loop; it can only print `SELFCHECK: FAST OK`).
