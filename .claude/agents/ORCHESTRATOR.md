# ORCHESTRATOR: run the best-combo workflow for one module

This file is for the orchestrator agent only. It is self-contained: it says what to feed each agent, what to run, what to
check, and when to stop. Sub-agents never see it. Evidence: `REPORT.md` (experiment 1, semantic_cleanup.py) and
`EXPERIMENT2.md` (experiment 2, file_slice.py). Base path: `/home/aiface/takeityours/meta-loop/` (called `meta-loop/` below).

## 0 What this is

The best combo found in two experiments is **decision list (the contract) + process + one-command self-check**, given to a fresh
coder, then verified from outside. Take away any part and you lose something:

| Part | What it gave |
|---|---|
| Decision list (= contract) | Fidelity: hidden tests 26/26 vs 15-16 without it (exp 1). No fidelity gain in exp 2 (17 vs 18 of 18). |
| Process + self-check | Robustness and craft: blind review 12 vs 4 in exp 2. Contract alone was only 5-6 in exp 1. |
| Both together | Best in both experiments. Never hand over the contract alone. |

Limits of the evidence: two modules, one or two runs per arm, one blind reviewer. Treat differences as hints, not proof.

## 0.1 New project quick start (read this when the project is not graphify)

Sections 4 and 5 were run inside `meta-loop/` with a reference module, hidden tests and helper scripts. A new project has none
of that. Everything that needs `meta-loop/` is marked **[meta-loop only]** below; use the generic line instead.

What you need before you start:
- a git repo for the project, with the callers of the module (or the place they will call it) and its contribution rules;
- a Python (or other) environment where the project's tests and linter run, and its path for the coder brief;
- the owner, available for the decisions and the YOUR-CHOICE review. If there is none, stop and say so. Do not fill the gap.

How to run it without `meta-loop/` tools:
1. Make RUN_DIR: `git worktree add <empty dir> HEAD`, or copy the repo. Delete the module if you are rebuilding it, or leave it
   absent if it is new. The project's existing tests that import it stay in place: they are the integration tests.
2. Put `agent/<task>/` (section 3 files) and `SPEC.md` into RUN_DIR. Write them fresh for this module. Copy the shape, not the
   content, from the examples named in section 3 (absolute paths: `/home/aiface/takeityours/meta-loop/...`; the orchestrator may read
   them, the coder may not).
3. Spawn the coder with the section 3 brief. It stays inside RUN_DIR.
4. Verify with what exists. With no reference module there are no hidden tests and no mutants of a reference. Use: the project's
   integration tests, the checks (written by the owner, not derived from the code), fuzz of the D6 invariants (section 5 item 4),
   a run on the real upstream producer's output (item 5), and blind review (section 7). Portability and mutation (items 2 and 3)
   need a second implementation; skip them and say so in the report.
5. Merge only if the scope check shows the coder changed the module and new test files, nothing else. Copy the result out of RUN_DIR;
   the coder never commits.

Untested: this generic path (no reference, no `meta-loop/` tools) has not been run end to end. Both experiments had a reference
module. Report any step that failed or had to be improvised, so the doc can be fixed.

## 1 Your role and hard rules

You orchestrate. You prepare folders, spawn agents, run verification, and report. You do not write the module.

1. The **owner (human)** decides limits, error formats, policies and non-goals. If a decision is open, ask. Do not invent it.
   If you may not ask, use YOUR-CHOICE tags (section 3) and say so in the report.
2. **Never copy the decision list from an existing implementation.** A contract transcribed from the reference carried the
   reference's flaws into every run (exp 1). Draft it from the callers and the repo rules only.
3. **Never show the coder** the reference module, hidden tests, scores, earlier runs, reports, or this file.
4. **Never tell the reviewer** which solution is the reference. A judge who knows inflates it (11/12 vs 4-5 blind).
5. The coder never edits `SPEC.md` or anything under `agent/`. Verify this with the scope check, not with trust.
6. Check any claim that would change a decision yourself (re-run the reproducer). One "data loss" claim in exp 1 was overstated.
7. Report outcomes as they are: failures, skipped steps, and what was not verified.

## 2 Roles and what each one is fed

| Role | Fed | Never fed | May write |
|---|---|---|---|
| Owner (human) | everything | n/a | decisions (D-ids) |
| Planner (optional agent) | callers of the module, repo rules, the decision-list template, the checks template, the repo path | the module's old code, hidden tests, scores | drafts of `DECISIONS.md` and `checks.py` |
| Coder (fresh agent per run) | only RUN_DIR: `SPEC.md`, `DECISIONS.md`, `PROCESS.md`, `checks.py`, `selfcheck.py`, plus the fixed brief | everything else in the list below | the module and new `tests/test_*.py` |
| Reviewer (different, stronger model) | name-hidden runnable copies, the rubric (section 7) | which one is the reference, scores, the key | nothing |
| Assessor (between runs, optional) | scores and run output | n/a | the harness files, after a gap is found |

Never shown to the coder: `oracle/` (reference module and its upstream tests = the hidden tests), `scores/`, `runs-archive/`,
`evidence/`, `CHANGELOG.md`, `REPORT.md`, `STATE.md`, `EXPERIMENT2.md`, `ablation/`, `blind-review/`.

## 3 Files you make per task (put them under `agent/<task>/` in the repo)

Working examples to copy from: `meta-loop/runs-archive/exp2-file_slice/decisions/` (`DECISIONS.md`, `checks.py`, `PROCESS.md`,
`selfcheck.py`) and `meta-loop/harness/` (the semantic_cleanup version). Both are module-specific: rewrite the contents, keep the shape.

**DECISIONS.md** (the contract). One id per line so tests and checks can point at it. Only what the code cannot infer.

    # Decisions for <module>
    D0  Purpose and callers: who calls it, with what, what they do with the result
    D1  Trust: which inputs are untrusted; what failure this prevents
    D2  Limits: name = value, what it counts, inclusive or not. Module constants, read at call time
    D3  Output and error format: exact strings or shapes
    D4  Bad input: return errors or raise; report all or first
    D5  Odd but harmless input: what stays valid
    D6  Must never: crash | edit its argument | delete data | leak | hang
    D7  Non-goals: what it does not do, and which code does that instead
    D8  Silence rule: where this list says nothing, choose the more tolerant, less destructive behaviour; comment `judgment:`
    D9+ module-specific

Tag every line `FROM-CALLERS (file:line)` or `YOUR-CHOICE`. The owner reviews every YOUR-CHOICE line. Exp 2 lesson: the planner's
choice for the cut rule ("last newline in the window") split a heading from its body and the coder copied it exactly.
For every rule that sets an output boundary, ask: does this break the structure the callers rely on?

**checks.py**: one runnable example per decision id. Prints `PASS D3 ...` or `FAIL D3 <expected> <got>`. Use your own fixture values.
If a known-good implementation exists, run the checks against it first. A check it fails must be a deliberate requirement
(exp 2: 6 of 13 failed on the reference by design, 1 was a planner mistake that the owner fixed).

**SPEC.md** (short):

    # Task: <one sentence>
    <2 to 4 sentences: callers, why, what is untrusted>
    Public names: <signatures with types>
    ## How to work
    1. agent/<task>/DECISIONS.md is the behaviour contract. Implement exactly that.
    2. agent/<task>/PROCESS.md is the order of work.
    3. Change only <the module> and new test files.
    ## Done
    `<python> agent/<task>/selfcheck.py` prints `SELFCHECK: DONE`.

**PROCESS.md** (copy as is; every step ends with a check; the next step does not start before it passes):
1. Read the callers and rules. Grep every call site. Done when you can say, per call site, what goes in, what is done with the
   result, and what the module must never do. Also run the real upstream producer on a sample and keep the output as a fixture.
2. Write header, constants, signatures only (bodies raise NotImplementedError). Header: what the module is, called from, why it
   exists, deliberately NOT done. Each constant gets the real reason, or `chosen by judgment`: never an invented reason.
   Each function gets a docstring: trust, return, copies or modifies, bad input. Done when it imports and the header answers
   who calls it, why, and what it does not do.
3. Write tests first, covering every decision id. One behaviour per test. For every limit: shrink with monkeypatch, equal is valid,
   one more is an error, pin the default. Compare errors with `==`. Must-NOT tests for every non-goal. Public names and tmp paths
   only. Done when the tests collect and fail.
4. Smallest code that passes. Reuse the repo's helpers. Add nothing the decisions do not list. Silence rule D8. Done when tests,
   checks, lint and scope pass.
5. Run the self-check, fix every FAIL. Done at `SELFCHECK: DONE`.
6. Report in at most 150 words: commands and results, every `judgment:` call, doubts.

**selfcheck.py**: one fixed script. Sections: own tests plus project integration tests; the checks; lint with the repo config;
scope (only the module and new test files changed). Optional and weak: keyword style checks (they produce plausible, partly false
comments), mutation of the coder's own tests (no measurable gain). Last line `SELFCHECK: DONE` only if nothing failed. Offer `--fast`.

**Coder brief** (fixed; fill the python path for the current machine):

    You are the CODER. Work only inside RUN_DIR (a git repo). Read RUN_DIR/SPEC.md and what it points to.
    Python with the project's dependencies: <MB_PY>. Do not read, list or search any other directory, do not use the network,
    do not run git commit, do not edit SPEC.md or anything under agent/. The only thing you may run outside RUN_DIR is that python.
    Finish when SPEC.md says you are done, or when you cannot make progress.
    Reply in at most 150 words: what you built, commands and what they showed, what you are unsure about,
    every path outside RUN_DIR you touched (write "none" if none).

**Planner brief** (when you use a planner): "Draft DECISIONS.md and checks.py for <module> from the callers and the repo rules
listed below. You may not read the module's current code or any tests of it. Use the template. Tag every line FROM-CALLERS
(file:line) or YOUR-CHOICE. List every place where two reasonable readers would differ."

## 4 Playbook for one iteration

1. **Owner pass.** Get or confirm the decisions (D2 numbers, D3 formats, D4 policy, D7 non-goals). With a planner: spawn it, then
   have the owner review every YOUR-CHOICE line. Budget from exp 2: planner about 7 min, owner review about 7 min.
2. **Validate the checks** on a known-good implementation if one exists (section 3). Fix the decisions, not the reference.
3. **Prepare the run folder.** **[meta-loop only]** `export MB_PY=$PWD/venv/bin/python MB_RUNS=<empty dir>`, then `tools/prep_run.sh N [ARM]`:
   fresh `$MB_RUNS/iter-N` = clean base repo + SPEC.md + the harness files. For a new module, copy your `agent/<task>/` files in.
   Any other project: section 0.1, steps 1 and 2.
4. **Spawn one fresh coder** with the brief and RUN_DIR. One coder per run; no memory between runs. It takes 6 to 12 minutes.
5. **Run the tests with timeouts.** Use `timeout 10` per test file or test. Exp 2: a pytest run over a module that opens FIFOs
   hung for 300 s. Do not use `pkill -f` from your own shell (it killed the shell, exit 144).
6. **Verify** (section 5). **[meta-loop only]** Score if a reference exists: `python3 -B tools/score.py $MB_RUNS/iter-N --out scores/iter-N.json`.
   First run `tools/score.py --selftest` on a new machine (passed here: 8/8 ok).
7. **Archive.** **[meta-loop only]** `tools/archive_run.sh N` (copies to `runs-archive/iter-N/`). Elsewhere: keep the run folder or its diff.
8. **Blind review** (section 7). **[meta-loop only]** `tools/make_blind.py` or `tools/make_blind2.py` make the name-hidden copies.
   Elsewhere: copy each solution to a folder named A, B, C and strip names from paths and comments that identify the source.
9. **Decide:** accept; or send the gap back to the owner (a missing or wrong decision) and run again; or freeze. A defect that traces to
   the decision list is fixed in the list, never patched into the coder's code.

## 5 Verification order (cheapest first)

1. Held-out tests by someone else, or the old implementation's tests when porting. Remember they encode the original author's
   choices: a miss is not always a defect. Score a keyword-neutral variant if a parameter name differs.
2. Portability: run the coder's tests against a second implementation. Failures pin the coder's own inventions. Expect some:
   exp 2's procedure arm had 14 of 67 fail on the reference. That is the price of pinning the contract.
3. Mutation: break the second implementation on purpose, count how many breaks the coder's tests catch.
4. Fuzz the D6 invariants: never raises on junk, does not edit its input, no hang, same input gives the same output.
5. Run on the real upstream producer's output through the real caller. If a dependency is missing (pypdf here), say that tests skipped.
6. Blind review.

## 6 What good looks like (numbers to compare against)

- Exp 1 best arm (`runs-archive/iter-1`, `iter-2`): hidden tests 26/26; output diffs 6 of 1010 (reference 0); reference mutants
  caught 94% (reference's own tests 65%); code/comment lines 159/23 and 153/20 (reference 244/53); blind rating 7 to 10 of 12
  (reference 4 and 5).
- Exp 2 procedure arm: hidden tests 17 of 18 (control 18); decision checks 13/13; no defect found in blind review, 12/12 (control 4,
  reference 6). The control's defects: slice over the cap, hang on a FIFO and on `cap=0`. The reference's: crash on a `FileSlice`
  input, hang on a FIFO.

## 7 Blind review prompt (give to the stronger model with the hidden copies)

    Score each solution 0 to 2 on: intent (header true and specific), contract (docstrings true), boundaries, failure model,
    fit with its real callers, tests. Read the real callers before judging behaviour. Every defect needs a one-line reproducer
    you ran. A defect you could not verify is listed but does not lower a score.

Cautions: the reviewer can infer which folder is which from test counts, and richer comments score well. Use two reviewers when it matters.

## 8 Do not do these

- Hand the coder the contract alone, or the process alone.
- Let the coder or the planner see the old module or the hidden tests.
- Treat fidelity to the original as quality.
- Add a rule from neighbouring docs without putting it in the decision list first.
- Trust keyword style checks; read the comments.
- Use two coders agreeing as proof. Use two coders only to find silence in the decision list: if they differ, a decision is missing.
- Draw a conclusion from one rater, one run, one module. Repeat first.

## 9 Known problems in the files this relies on

- `briefs/coder.md` and `STATE.md` still hold the first laptop's absolute paths (`/tmp/claude-1000/...`). Use your own `MB_PY` and
  `MB_RUNS` in the brief.
- `harness/` is specific to `semantic_cleanup.py` (the grep in PROCESS step 1, the limit names in `selfcheck.py`, all of `CONTRACT.md`
  and `contract_checks.py`). The exp 2 set in `runs-archive/exp2-file_slice/decisions/` is the second example.
- No `templates/` folder exists yet; the two example sets above stand in for it.
- The planner brief and the exp 2 coder brief were not archived; section 3 holds the text to reuse.
- `HANDOFF.md` does not exist on this server.
- The procedure arm's exp 2 module still carries the planner's heading-cut rule (decision D12). If you re-run that module,
  fix D12 first.
