# T2.1 planner notes: what the owner reviews (O11: defaults "A" are accepted unless the final PR review says otherwise)

Drafted: `agent/t2-1-extract/` = SPEC.md, DECISIONS.md (D0-D22), PROCESS.md, checks.mjs (one check per D-id), selfcheck.py, golden/ (20 fixture sources + graphify 0.9.93 output + MANIFEST.sha256), gen_golden.py (orchestrator only).
YOUR-CHOICE: 25 lines (27 tags) in 20 decision ids (D1-D7, D9-D22). FROM-OWNER: O6, O11. No owner question blocks the run.
Status: `node agent/t2-1-extract/checks.mjs` prints 23 clean FAIL lines and `python3 agent/t2-1-extract/selfcheck.py [--fast]` ends `SELFCHECK: FAIL` (module not built, grammars not installed). The checks were NOT run against an implementation (none exists); the D11-D14 and D16 expectations were confirmed against graphify 0.9.93 itself, the rest (D2-D6, D15, D17-D20) only against the decision text. Expect a few planner mistakes there; triage after the first coder run.

## A. Decisions with the widest blast radius (A = default, B = alternative)

| # | D | A (default) | B | Why it matters |
|---|---|---|---|---|
| 1 | D21 | gate compares ids AND labels, start lines and parents with graphify on the 20 files | ids only (the spec's literal "id suffixes equal") | lines are the only proof of spec §10's "WASM spans = native spans"; labels feed the lexical seed tiers (spec:305). Costs the coder graphify quirks (a heading label keeps `###`). |
| 2 | D15 | SQL by a statement scanner (tables, views, functions, types); no SQL in the golden | build DerekStride's tree-sitter-sql 0.3.11 to WASM (`tree-sitter build --wasm`, needs emscripten or docker), commit the ~1 MB .wasm, add SQL fixtures from a graphify with the `sql` extra | no published SQL WASM exists; graphify 0.9.93 as installed skips `.sql`; graphify's SQL ids on this repo's `{schema}.`-templated migrations are wrong anyway (tables lost, `hnsw` as a table). Spec:283 says web-tree-sitter for sql. |
| 3 | D7 | only `contains` edges; imports and refs stay raw for T2.2 | resolve relative imports to `imports_from` edges here | spec:283 lists `imports` edges as extract output. Resolving needs the file set (Python absolute imports, index files), so it is split; T2.2's planner must take D18/D19 as its input shapes. |
| 4 | D7 | same-stem collision (`foo.ts` + `foo.py` in one dir) not handled; ids stay per-file pure | copy graphify's cross-file rename of one file id | graphify gives `…_edge_ts_…_edge` style ids then; per-file purity keeps incremental rebuilds stable (spec:237 "stable across rebuilds"). Two files then share an id, which T2.2 must detect (the PK is (user, project, id)). |
| 5 | D11, D14, D15, D17 | new node types `variable` (module consts, enum members), `key` (JSON keys), `table` (SQL) | squeeze into the spec list (`type`/`module`) or drop those nodes | the spec's type list (spec:246) has no slot; dropping them fails `graph.ids`. `graph_search types[]` (T2.4) and the prompt line ranking (T5.1) see these names. |
| 6 | D16 | markdown by a line scanner equal to graphify's (ATX only, backtick fences only, no setext) | a CommonMark parser (spec:68 "a markdown parser") | a real parser adds setext/indented headings and `~~~` fences, changing doc ids vs graphify and breaking the gate. |
| 7 | D10 | web-tree-sitter 0.25.10 + official grammar npm packages at graphify's exact grammar versions (ts 0.23.2, js 0.25.0, py 0.25.0, bash 0.25.1, json 0.24.8) | newest web-tree-sitter 0.27.x, or `@vscode/tree-sitter-wasm` (one package, no native deps, unknown grammar versions) | same grammar versions = same trees = same spans. The npm packages carry unused native `install` scripts (pnpm 10 skips them) and a missing optional peer warning. |

## B. Other YOUR-CHOICE items (keep unless told)

| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | labels cleaned at extraction (control chars → space, ≤ 256 code points); `<private>` etc. stay for render-time `sanitize` | clean only at render | graph_nodes rows are already safe; graphify labels are short so parity holds. |
| D2 | `parseTimeoutMs` 5000; `maxReceiverChars` 128; JSON depth 6 / 500 pairs and frontmatter 200 lines copied from graphify | other numbers | timeouts trade one slow file vs the 300 s job budget. |
| D2 | `EXTRACTOR_VERSION = 'ctc-ts-1'` | anything that differs from the Python values | must change whenever ids or raw shapes change, or T2.2 will not re-extract. |
| D3/D4 | `extractFile` never throws; all-or-nothing result with an error code (`bad_path unsupported too_large parse_timeout grammar_missing internal`) | throw | one bad file never stops a rebuild (spec:352). |
| D5 | stem that normalises to `''` (`_.ts`, `🙂.md`) falls back to the path with extension (`code:ts`, `doc:md`) | skip the file | graphify skips such names; a skipped file would never get a note. |
| D6 | walks bounded at depth 2,000 (or iterative) | no bound | a deep JSON/bracket file must not overflow the stack. |
| D7 | no rationale (docstring/comment) nodes, no `ref_*` package nodes, no `ctx:`/capability ids in T2.1 | add them now | graphify has rationale nodes; spec has `rationale_for`; no task row names them, so they are deferred, not dropped forever. |
| D9 | casefold built per code point with a Cherokee exception | a full CaseFolding.txt table | the 25 golden vectors pin the result either way. |
| D12 | defs under `if __name__ == "__main__":` are module-level functions | not nodes | the golden (`bundle.py` `cap`, `aovr`) requires it. |
| D13 | bash script entry has type `function` | `module` | only changes `graph_search` type filters. |
| D14 | data JSON (not a config file) gives a file node | nothing (graphify) | not in the golden; lets the pre-tool note name the file. |
| D17 | file node first, then document order; first duplicate id wins (getter/setter, two `def f`) | last wins | graphify keeps the first; T2.4 explain shows that line. |
| D18-D20 | raw shapes `RawImport`, `RawRef` (call/new/jsx/extends/implements), `RawMention` (symbol/path_symbol/link) | other shapes, or resolve in T2.1 | they are T2.2's/T2.3's input; changing them later bumps `EXTRACTOR_VERSION`. |
| D19 | bash refs include builtins and external commands | only names defined in the file set | T2.2 drops what does not resolve; more raw rows, simpler rule. |
| D20 | links in frontmatter are ignored | scan them (graphify does) | graphify keeps frontmatter wikilinks for Obsidian; ctc has none. |
| D22 | the six deps are `dependencies` of `@ctc/core`, exact pins | devDependencies, or a root install | the worker imports `@ctc/core/graph` at runtime. |

## C. Places where two reasonable readers would differ
- **"id suffixes equal graphify's"** for which nodes: the golden keeps graphify nodes of file_type `code`/`document` whose `source_file` is the fixture; it excludes `rationale` nodes, `ref_*` concept nodes and external stubs without a source file (listed per file under `excluded` in `golden/ids.json`).
- **Parents**: graphify uses `contains`, `method`, `case_of` (enum members) and `defines` (bash functions); ctc writes all four as `contains`.
- **Which graphify?** The golden comes from the installed graphify 0.9.93 (`~/.local/share/uv/tools/graphifyy`), not 0.9.97 (spec:816 open item). A later graphify can change ids; regenerate with `gen_golden.py` only on purpose, then update `GOLDEN_MANIFEST_SHA256` in selfcheck.py and the contract hash.
- **Synthetic fixtures**: 4 of the 20 files are planner-written (`fixtures/synthetic/edge.ts`, `shapes.py`, `tools.sh`, `notes.md`) because the repo has no bash functions, no enums/abstract classes and no markdown frontmatter/fence/duplicate-heading cases; the other 16 are copies of repo files at e5f1647. They are frozen copies, so later edits of those repo files do not move the gate.
- **`edge.py` → `shapes.py`**: a fixture named `edge.py` next to `edge.ts` triggered graphify's same-stem rename (open item A4); renamed so the gate does not depend on the cross-file pass.
- **Purity**: spec:99 says `packages/core` is pure; `loadGrammars` reads six WASM files from `node_modules` (the package's own assets, not user data). Moving it to `apps/worker` would make every caller pass bytes.
- **`.txt` fixture copies under `src/`**: keeps them out of tsc, ESLint and Vitest without touching `eslint.config.js` or tsconfig; a reader may prefer `packages/core/fixtures/` plus an ESLint ignore (a root config change, out of scope).
- **Pre-existing failure**: `packages/shared` `schema-assumptions.test.ts > … every column the repositories use exists` fails on HEAD (T1.3 expects `projects.graph_epoch`/`mem_epoch`, T1.2 does not create them; see agent/t1-34-OPEN.md A1). selfcheck.py ignores exactly that one test; fixing it belongs to a T1.2/T1.3 follow-up, not T2.1.
- **Network**: the coder runs `pnpm --filter @ctc/core add` itself (O11 allows the registry). If the orchestrator prefers to pre-install, run that command and `selfcheck.py --snapshot` before the coder starts.
