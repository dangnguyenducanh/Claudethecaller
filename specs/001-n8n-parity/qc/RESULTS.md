# Browser QC results — n8n parity (2026-10-26)

Run on an isolated QC daemon built from `m5-n8n-parity` (after the review fixes, `3b19be8`). It used port 18311 with its own socket and `HOME`, a separate `ctc_qc` database on the scratch Postgres, a throwaway git repo as the only project, and the fake `claude` (agent nodes return "ok" with 0 tokens). The owner's daemon on :18310 and Supabase were not touched. Screenshots are at 1440x900 in light theme, under `qc/<US>/`.

| Task | Story | Result | Evidence |
|---|---|---|---|
| T020 | US1 retry / run from / run to | PASS | Retry, Run from here and Run to here create linked child runs; earlier steps are tagged `reused`; run-to ends `done` after its node. `US1/*` |
| T032 | US2 pins | PASS | A non-object pin is rejected inline; a saved pin shows a badge; "Pin output of run #N" works; Use pins → agent `pinned`, 0 tokens. `US2/*` |
| T057 | US6 disabled | PASS | The node is greyed and tagged; disabling an IF gives 422; the run shows "skipped (disabled)". `US6/*` |
| T068 | US7 retry-on-fail | PASS | Retry fields write `retry {max_tries, wait_s}`; the run shows tries 3. `US7/*` |
| T076 | US8 error branch | PASS | Red error handle and edge; the fixer loop runs; export refuses `error_edge`. `US8/*` |
| T094 | US10 defect fixes | PARTIAL | (1) A quota run can't be produced with the fake claude. Verified in code (quota is in the active statuses), with a waiting run as a stand-in for live polling. (4) The uppercase compare route works. (5) `plan` is selectable; shell readonly gives 422. `US10/*` |
| T104 | US11 IF + Switch | PASS | IF with 2 conditions (or) and a 3-case switch save and reload; renaming a case moves its edge; a bad regex gives 422; export refuses regex. `US11/*` |
| T122 | US13 graph extras | PASS | Warnings shown on save; the stop node fails the run with its message; minute settings persist. `US13/*` |
| T133 | US14 for-each | PASS | Body/done handles; the body runs 3 times; an exit edge gives 422; export refuses `has_foreach`. `US14/*` |
| T147 | US15 editor parity | PASS | Undo/redo, copy/paste with edges, notes, rename rewrite, the save-conflict Reload/Overwrite prompt and the step list. `US15/*` |
| T162 | US16 typed inputs | PASS | The run dialog renders declared inputs; a missing required input is rejected; the trigger subtitle lists them. `US16/*` |

**Live planned-stop check (ticket 15, T083):** run #18 (`slow`: sleep 12, then `after`). `ctc daemon stop` was called while `slow` ran. The stop waited about 9 s for the batch, `slow` stayed `done`, and the run went back to `queued`. After `ctc daemon start` the run finished `done`. `after` ran once and read the file `slow` had written; `slow` was never re-run.

## Defects found (not fixed)

- **D2 (medium, Runs.tsx):** a node whose last visit is a trailing `skipped` shows "skipped" on the run canvas although earlier visits were `done`. Seen on a for-each body (greet ×3 done + a 4th skipped) and on a fixer loop.
- **D1 (low, Runs.tsx):** the run canvas does not fit the graph on load; nodes sit outside the pane until Fit View is clicked.
- **D3 (low, Workflows.tsx pin editor):** an invalid pin (`[1,2]`) shows the inline error, but Save still says "Saved" and silently drops the pin.
- **D4 (low, US8):** an error edge hand-written without `on_error: error_output` is invisible on the canvas, so it can't be seen or deleted there; only the 422 names it.
- **D5 (cosmetic):** "a if node" / "a agent node" grammar in validator messages; the retry error reads "exit 1 on try 1/1:" with an empty tail when stderr is empty.

## Fixes after QC (2026-10-26)

- **D2:** fixed in `Runs.tsx`. A node's canvas status is now its latest visit that ran (a trailing skip is ignored), else its latest visit.
- **D1:** fixed in `Runs.tsx`. `FitOnce` fits the run canvas once React Flow reports every node measured (`useNodesInitialized`).
- **D3:** fixed in `Workflows.tsx`. A `BlurField` that rejected its value sets `aria-invalid`, and Save refuses with a message until it is fixed or cleared.
- **D4:** fixed in `Workflows.tsx`. A node with an outgoing `error` edge gets its red error handle even without `on_error: error_output`, with a tooltip saying what is missing, so the edge shows and can be deleted.
- **D5:** fixed. Validator messages say "an if node" / "an agent node", and the retry error drops the colon when there is no output tail (engine and native export). Covered by tests/test_graph_templates.py, tests/test_disabled_node.py and tests/test_retry_on_fail.py.

**Browser re-check (same isolated QC daemon, build of `a8ad531`): D1–D4 PASS, no new defects, no console errors.** D1: #run/10 and #run/16 fit on a fresh load. D2: #run/17 greet shows done ×3 and #run/12 fix shows done, although their last visits are skipped. D3: Save refuses with the message after a `[1,2]` pin, and the file stays unchanged. D4: a hand-written error edge without on_error shows a red handle (with its tooltip in the DOM) and can be deleted. Screenshots are in `qc/recheck/`. Cosmetic note, not a fix regression: foreach-demo.yaml's hand-written `pos` values are 200 px apart, so its wide nodes overlap a little on the canvas.
