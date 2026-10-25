# claudethecaller

Local skill/workflow router for coding agents. `PLAN.md` is the spec.

## Team runs

The workflow runner executes your workflows with your own `claude` login. A team shares workflow files and one run-history database, never a login or a runner.

- **Your own daemon, your own login.** Each teammate runs `uv run ctc daemon start` on their own machine, logged in to `claude` with their own Pro/Max account. `claude auth status` must show `authMethod: claude.ai` (an API key is refused), and `claude --version` must match `runner.claude_version` in `config/server.yaml` (`uv run ctc runner upgrade` re-pins it).
- **Workflow files live in git** at `<repo>/.claude/ctc-workflows/<name>.yaml`. Pull to get a teammate's workflow, commit and push to share yours. A run walks the file as it was when the run was queued.
- **Runs never touch your checkout.** Each run gets its own worktree and branch `ctc/<workflow>-<id>` under `~/.claudethecaller/runs/<id>/`, kept after the run; node logs stay on the machine that ran them. Pushing or opening a PR from a workflow needs an approval node in front of it.
- **History is shared, views are not.** Runs and their steps go to the team's Supabase (`CTC_DATABASE_URL` in `.env`), keyed by `owner` = your `claude auth status` email. The dashboard, `/api/runs*`, `ctc runs` and the MCP `workflow_status` tool show only your own runs; anyone else's run id is a 404. Your daemon claims only your runs and refuses to start one if `claude` is now logged in as someone else.
- **Runs never feed the router.** A run's `claude` sessions (cwd under any `~/.claudethecaller/runs/`, yours or a teammate's) get no suggestions and write no decisions, sessions, events or memories; history import and backfill skip their transcripts.
- **Never share a login.** Anthropic's terms do not allow one Pro/Max subscription to serve other people's requests. Don't run workflows for teammates on your login, don't put a runner on a shared box, and don't expose your daemon's run endpoints: `/api/runs*` and the MCP run tools are served on 127.0.0.1 and the unix socket only, and refused in shared mode.

A teammate's first run:

```sh
git clone <repo> && cd claudethecaller && uv sync
echo 'CTC_DATABASE_URL=<the team Supabase session-pooler URL>' >> .env
claude            # log in with your own account, then exit
uv run ctc daemon start
uv run ctc run smoke --wait   # ends `done` on branch ctc/smoke-<id>
uv run ctc runs               # your runs only
```
