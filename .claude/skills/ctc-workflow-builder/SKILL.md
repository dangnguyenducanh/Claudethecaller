---
name: ctc-workflow-builder
description: Draft a ctc (claudethecaller) workflow YAML from a plain description of the steps, check it with `ctc workflow validate`, and save it under .claude/ctc-workflows/. Use when asked to build, draft or write a ctc workflow, runner workflow or canvas workflow.
---

# ctc workflow builder

Turn a description ("run the tests, let an agent fix them until green, then open a PR after my OK") into
`.claude/ctc-workflows/<name>.yaml` that `ctc workflow validate` accepts. Draft and validate only: never run it.

## File shape

```yaml
name: fix-tests                   # file name without .yaml: letters, digits, - or _
description: what Claude matches against when it routes a task here
settings: {permission: worktree}  # also: allow_extra_usage, auto_resume, max_run_tokens, max_run_minutes,
                                  # approval_timeout_minutes (numbers > 0), notify (a shell command)
vars: {branch_prefix: fix}        # optional constants, read as {{vars.<name>}}
defaults: {max_visits: 3}         # optional: fields every node gets unless it sets its own
nodes:
  - {id: start, type: trigger, pos: [0, 0]}
edges:
  - {from: start, to: next}       # handle: needed on IF, switch, foreach and error edges
```

Node ids: letters, digits, `-`, `_`; not `input`, `run`, `now`, `vars`, `item`, `index`. Give each node a `pos: [x, y]`
(x grows ~200 per step) so the dashboard canvas reads left to right.

## Node types and fields

- **trigger** (exactly one): `inputs: [{name, type: string|number|bool|json, required, default, description}]`;
  each run start (editor dialog, `ctc run --input name=value`, MCP `run_workflow` inputs, API) checks and coerces
  them, read as `{{input.<name>}}`. Without `inputs`, `{{input}}` is the run's free text.
- **agent**: `prompt` and/or `cap` (a capability id, e.g. `user:tdd-fix`), `agent` (a subagent name), `model`,
  `effort`, `permission_mode: acceptEdits|dontAsk|plan`, `readonly: true` (read tools only; ready readonly agents run
  in parallel), `allowed_tools`, `json_schema`, `resume_from` (an earlier agent's id), `max_turns`, `timeout_s`.
  Output: `result`, `structured_output`, `is_error`, `subtype`.
- **shell**: `command`; leave `{{...}}` unquoted, the runner shell-quotes each value. `timeout_s`. Output:
  `exit_code`, `stdout_tail`, `stderr_tail`, `duration_ms`. A non-zero exit is data unless `retry` or `on_error` says
  otherwise. `idempotent: true` allows `retry: {max_tries: 1..5, wait_s: 0..300}` (shells only; agents never retry).
- agent and shell: `on_error: stop|continue|error_output` (default stop). `error_output` needs an edge with
  `handle: error`, which carries `{error, output_tail, exit_code}`; the other edges carry the success.
  `pin: {output: {...}}` is the output a run started with "Use pins" / `--pinned` returns instead of running.
- **if**: `conditions: [{path, op, value}]` + `combine: and|or`. ops: `eq ne gt ge lt le contains not_contains regex
  exists truthy`; `path` is a dotted ref without braces (`test.exit_code`, `input.dry_run`). Exactly two out-edges,
  `handle: "true"` and `handle: "false"`. Output `{value}`.
- **switch**: `cases: [{name, conditions, combine}]` (lowercase names, not `default`); out-edge handles are case
  names or `default`; the first matching case fires. Output `{case}`.
- **foreach**: `items` (a field of a node that runs before it, holding a JSON array, e.g. `list.stdout_tail`),
  `max_items` (default 50). One `handle: body` edge into nodes that all lead back to the foreach, one `handle: done`
  edge on. Body nodes read `{{item}}` and `{{index}}`; the done edge gets `{items: [body outputs]}`.
- **stop**: `message` (rendered); fails the run with it; no out-edges.
- **approval**: `message`; the run waits for approve or reject (dashboard, `ctc approve|reject`, MCP).
- **merge**: no fields; waits for all its inputs, output `{inputs: {node_id: output}}`.
- Any node: `notes` (text shown on hover), `max_visits` (a loop cap, default 3). `disabled: true` on any node but
  trigger, if, switch and foreach: it is skipped and passes its upstream output on.

## Templates

`{{input}}` / `{{input.<name>}}`, `{{run.id}}`, `{{run.visit}}`, `{{run.trigger}}`, `{{run.branch}}`, `{{now}}`,
`{{vars.<name>}}`, `{{<node id>.<field>}}` (dotted paths go deeper: `{{a.structured_output.files.0}}`), `{{item}}` and
`{{index}}` in a foreach body. A ref to a node that cannot run first, a field its type never outputs or an undeclared
input is a warning: it would render empty.

## Hard rules (validate rejects these)

- Exactly one trigger; every edge names existing nodes; no duplicate ids.
- `git push`, `gh pr create` or `gh pr merge` in a shell only after an approval node on every path to it.
- No merge, approval or nested foreach inside a loop (a back-edge cycle); inside a loop only an IF or switch (or an
  `error_output` node's ok + error pair) may have more than one out-edge.
- `permission_mode` never bypassPermissions; shells have no `readonly`.

## Steps

1. Read one or two files in `.claude/ctc-workflows/` (e.g. `loop-demo.yaml`, `inputs-demo.yaml`) for the style.
2. Map the description to nodes and edges. Prefer shells for anything a command does; use agents only for judgement.
   Ask for typed trigger `inputs` when the description names values a caller supplies.
3. Write `.claude/ctc-workflows/<name>.yaml` (do not overwrite an existing file without asking).
4. Run `uv run ctc workflow validate .claude/ctc-workflows/<name>.yaml`. It prints `● error: ... node <id>` and
   `● warning: ...` lines, then `valid` or `N errors, M warnings`, and exits 1 on any error.
5. Fix every error and run it again until it exits 0. Fix warnings too unless they are deliberate.
6. Report the file path, the validate output and any warnings you kept. Do not run the workflow.
