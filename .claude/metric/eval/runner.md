# Eval: workflow runner (F4)

What it measures: the workflow engine (`apps/worker/src/runner`, `packages/core/src/runner`) running three sample workflows end to end with a fake
agent (`runner/fake-agent.mjs`, no model, no network), in throwaway git repos, on the scratch Postgres. It checks that a run reaches `done`
without retries, that a gate waits for an answer, that a fan-out uses one worktree per child and the join merges them, and that a loop ends
by its condition. It does not measure agent quality.

## Samples

| File | Shape | Covers |
| --- | --- | --- |
| `runner/implement-review.yaml` | trigger, agent (new worktree), agent (parent worktree, `plan`), approval, shell | prompt rendering with an upstream output, worktree reuse, a gate |
| `runner/fanout-merge.yaml` | trigger, fanout of 3, join `merge`, shell in the merged worktree | 3 children in 3 worktrees, the merge of 3 branches |
| `runner/loop-gate.yaml` | trigger, shell, shell, if, approval, shell with a back-edge | a loop capped by `max_visits`, a gate after the loop |

## Metrics

`status`, `steps` (rows), `attempts` (rows beyond the first for a `(node, visit)`), `agent_steps`, `prompt_outcome` of the first agent step, `children`
(fan-out child rows), `gate_wait_ms` (time a gate waited before it was answered with its first option), `wall_ms`, `cost_usd` (sum of the fake agent's
reported cost). The Python runner kept no comparable metric file, so this set is new ([UNVERIFIED] that it is the set the owner meant by "metrics as
today", spec:736).

## Thresholds (asserted by `apps/worker/src/runner/runner.md.int.test.ts`)

- every run ends `done`, with `attempts` 0 and `wall_ms` under 60,000;
- `implement-review`: `prompt_outcome` is `delivered` and the review prompt contains the implementer's summary;
- `fanout-merge`: `children` 3, three distinct worktrees, the merged tree holds all three files;
- `loop-gate`: the loop body ran exactly 3 times.

## Run

```
CTC_SCRATCH_PG_URL=postgres://postgres:...@127.0.0.1:18304/postgres node --import tsx .claude/metric/eval/runner/run.mjs
```

## Results

<!-- results:start -->
| workflow | status | steps | attempts | agent_steps | prompt_outcome | children | gate_wait_ms | wall_ms | cost_usd |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| implement-review | done | 4 | 0 | 2 | delivered | 0 | 4 | 986 | 0.5 |
| fanout-merge | done | 6 | 0 | 3 | delivered | 3 | 0 | 3151 | 0.75 |
| loop-gate | done | 11 | 0 | 0 | null | 0 | 4 | 990 | 0 |
<!-- results:end -->
