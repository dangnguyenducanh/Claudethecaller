# T5.1 planner notes: what the owner reviews in the final PR

Drafted: `agent/t5-1-suggest/` (SPEC, DECISIONS D0-D23, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE tags: every one is a default under O11.
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built: 24/24 ids fail with that reason). The checks were validated against a throwaway reference
implementation I wrote outside the repo (24/24 pass after fixing one planner typo in D3); that reference is not shown to the coder and not kept. The two gates were never run
(no implementation): expect the first coder run to find planner mistakes in the gate method; triage by fixing the check, not the code, when a check contradicts DECISIONS.md.
Orchestrator before the coder starts: `python3 agent/t5-1-suggest/selfcheck.py --snapshot`; keep TEI :18300, scratch Postgres :18304 and scratch Redis :18395 up (never restart them);
the first full run embeds the n8n snapshot graph and the 6,006 SkillRet skills (about 5 to 10 minutes, then served from `.ctc-dev/eval/vec-cache/`). Run the latency gate with nothing else heavy on the host.

## A. Highest risk (ordered by blast radius)
1. **`suggest.context` is defined here, not by the spec's eval docs.** spec:368 points at `contextbench.md` / `mulocbench.md`, which do not exist in this checkout. D22 re-creates the m6 G7 method
   (n8n-parity tickets, test 09-16, Recall@3 0.750 = 6/8 in PLAN.md:851) on a git snapshot (`a8ad531`) so that the ticket files exist in the graph. Two readers differ: (a) measure on today's
   HEAD graph, where those tickets are deleted and the TypeScript pipeline sees different context nodes; (b) require the one pointer of the rendered line (@1) instead of the top 3 file candidates.
   The test tickets' truth lists are broad (`dashboard/src/Workflows.tsx`, `types.ts` appear in most), so @3 may pass for easy reasons; @1 of the line is reported but not asserted.
2. **False triggers are not measured.** The m6 bar included false-trigger ≤ 10% on MetaTool negatives (PLAN.md:851); the spec's gate (spec:368) does not. Lexical seeds always score 1.0 for their best
   match and skill cosines are high for chit-chat, so a "thanks" prompt can still get a line (D12). If you want the bar back, add MetaTool negatives to D22 and assert `≤ 0.10`.
3. **Latency on a shared GPU host.** `suggest.latency` times the real TEI embed inside the cold path (cold p95 ≤ 150 ms includes one `/embed` of a short prompt). The T0.2 baseline file
   (`fixtures/py-baseline/latency.json`) was never recorded in this checkout, so there is no Python number to compare with; the gate measures the handler in process (no curl, no socket, no Fastify), so the
   real hook adds a few ms the gate does not see. A noisy neighbour on :18300 can fail the gate; rerun before concluding.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | text in the line cut to 256 code points; cached value shape-checked; the finished line never sanitized | no cut; trust the cache | a poisoned `sug:` value or a label with `ctc: ` can never reach the model |
| D2 | `embedDeadlineMs` 100, `lexicalChars` 500 | other numbers | 100 + the 140 budget leave 40 ms for walk/rank/render; `lexicalSeeds` has no cut of its own and scans all labels once per token |
| D3 | JSON keys and 4-decimal rounding; `ms` stages `project, cache, embed, seeds, walk, rank, render, total`; 422/503 messages | other names | `evaluation/` and the dashboard read this shape; spec:109 only says "seeds, candidates, line, timings" |
| D4 | blank prompt is valid (empty line, no model call); non-absolute `cwd` is `422` on suggest and `204` on the hook | blank = `422` | hooks never error (spec:164); a blank turn must not cost a TEI call |
| D5 | tolerant list of odd inputs | reject some | — |
| D6 | the "must never" list beyond the spec's lines | fewer | pins no-log, no-extra-writes, no-rerank so a later edit cannot add them quietly |
| D7 | non-goals: no single-flight, no abstain gate, no memories in the line, no `/hook/pre` | add one | single-flight would cap duplicate TEI calls when the same prompt arrives during the background fill |
| D9 | `@ctc/core/graph/push` (new dir), `@ctc/shared/schemas/suggest`, `apps/web/src/suggest`; `SuggestDeps` takes `graph: Pick<GraphStore,'get'>` and `skills: Pick<SkillChannel,'search'>` | build the store/channel inside `createSuggest` | the bootstrap already owns one store and one channel with their `onInval`; two copies would double RAM and miss invalidations |
| D10 | embed the channel's exact prefixed text once for the graph vector; the channel's own embed then hits `emb:` | embed the raw prompt for the graph (as T2.4 `graph_search` does); a second TEI call | one text means one TEI round trip when a cache is injected; the raw text may rank context nodes differently (see C) |
| D11 | unknown project → skill-only answer | empty reply | the skill library still helps in a repo ctc has not seen |
| D12 | seed types list; lexical "always passes" the floor; skill seeds need `cosine ≥ floor`; skill score = cosine | RRF score; a separate skill floor | T3.3 D3 chose cosine so T5.1 can compare it with the graph floor |
| D14 | `max_pointers` (3) candidates per slot, files distinct by path; tie order score, hop, symbol before file, id | only the winner | the 3 file candidates are what the context gate counts |
| D15 | piece order and cut ladder (decision, skill, task label, pointer) | cut at the last space | a cut must not split a piece (ORCHESTRATOR §3 lesson from the heading cut) |
| D16 | degraded answers are not cached; the empty line is cached; the write is not awaited | cache everything | a cached lexical-only line would hide a TEI recovery for an hour |
| D17 | TEI deadline counts as `embed`; a rejecting channel counts as `store`; `rerank` passes through | separate codes | `/v1/suggest` returns 503 only for `embed` |
| D19 | stage names | — | — |
| D20 | skill names get the same cleaning as labels | none | names come from files the user does not review |
| D21 | in-process handler timing; 100 SkillRet prompts, 3 warm-ups; all 6,006 skills + the n8n snapshot graph; real Redis `createCache`; strict switch `CTC_GATE_SUGGEST=1` | HTTP over a socket; the library of this machine | the full SkillRet library is the worst case for the dense pass (6,006 × 1,024 floats) |
| D22 | snapshot `a8ad531`; truth rules; @3 over `candidates.file`; empty skill channel | HEAD graph; @1 | see A.1 |
| D23 | narrow `projectOf`'s first parameter type (no behaviour change); add `model_unavailable` to `http.ts` | cast `MemoryApiDeps` / write a second project lookup; map the 503 inside the route | two small additive edits to merged T3.2/T4.3 files, each with tests; the scope check lists them |

## C. Places where two reasonable readers differ
- spec:303 "Embed the prompt (TEI, `emb:` cache)": one vector for the graph channel and the skill channel? T2.4's `graph_search` embeds the raw text while T3.3's channel embeds the SKILLRET query prefix;
  graph nodes are embedded as plain documents. D10 uses the prefixed text for both (the model's intended query form). If `suggest.context` is below 0.75, the raw-text variant is the first thing to try; it is
  not allowed by the contract, so a coder who hits the problem reports it instead of switching.
- spec:310 "Pick at most one each…" and the m6 line's three code pointers (`graph_push.max_pointers: 3`): the line has one pointer; the other candidates travel in `/v1/suggest` (D14).
- spec:310 "Nothing above the floor → empty reply": D12 reads it as "no seed passes the floor". Reading it as "every shown node must score ≥ floor after the 0.5^hop decay" would empty most lines
  (a hop-1 task reached from a 0.5-cosine seed scores 0.25).
- spec:312 "Over budget: reply empty now, finish in the background": D17/D18 add an embed deadline (100 ms) so a slow TEI yields a lexical line inside the budget instead of an empty reply; spec:206 says
  "TEI down: lexical seeds only", which this implements for "slow" as well.
- spec:105 says the empty prompt reply is `200 text/plain` "one line or empty"; spec:147 says `204` for an empty hook reply. D3 follows the T4.3 hook (`204`), as the curl hook prints nothing either way.
- spec:109 lists `/v1/suggest` as "JSON with seeds, candidates, line, timings" with no field names; D3 invents them.
- The skill channel's keyword leg and reranker are off at today's tuned weights (T3.3 OPEN A.2), so the "skill" seed channel here is dense-only.
- Not covered by `checks.mjs`: the real TEI, Postgres, Redis, the snapshot graph build and both gate numbers (only the gates and the self-check's re-read of their result files cover those).
- `schema-assumptions.test.ts` is still red at the base (T1.2 migrations lack `projects.graph_epoch` / `mem_epoch`, T1.3 D10); `selfcheck.py` keeps the `KNOWN_RED` tolerance used by T3.1 to T4.3. The 60 s
  Postgres `graph_epoch` poll that would heal a missed `ctc:inval` (spec:205) cannot work until that migration exists; T5.1 reads the epoch from Redis only.
