# Workflow Runner (m5): n8n-style, on your own Claude subscription

*Status: DRAFT, 2026-10-22. One file: requirements, research, decisions and build plan. Adversarial verify was skipped; unverified items are marked **(unverified)**. The build plan lives in `PLAN.md` → "Workflow runner (m5)".*

---

# Part 1: Requirements

## Problem
Coders with large skill libraries repeat the same multi-step agent chains by hand: plan → implement → test → review → PR. They type each step, wait for it, and carry its result into the next. Claude Code can't save a chain as a unit that is visual, runnable and schedulable on the subscription they already pay for. n8n-style tools call the paid API and know nothing of the coder's skills, repos or branches. Left unsolved, every chain needs babysitting, steps get skipped, and nothing records what each step changed.

## Evidence
- Transcript scan, this host, 2026-09-21 → 2026-10-22:
  - 75 sessions and 386 typed prompts.
  - The owner typed skills or commands by name 22 times, in 10 sessions.
  - Only one chain repeats across sessions: `ecc:plan-prd → ponytail:ponytail`, in 2 sessions (3 counting today).
- The router's evidence (PLAN.md, 2026-10-20): 52 `Skill` calls in about 10,000 tool calls. Chains rarely run unless typed.
- Feasibility only, not demand: on 2026-10-22 a headless `claude -p` run on the owner's Max login succeeded on this host. `claude auth status` reported `authMethod: claude.ai`, and no API key is set.
- **Assumption, partly supported:** re-typing chains is a frequent, costly pain. Validate it with milestone 1 usage, and with a re-scan of a longer history if one exists.

## Users
- **Primary:** the owner, a solo developer on Claude Max with 600+ skills, agents and commands. The need starts when they're about to drive a known chain by hand, or want one to run while they're away.
- **Secondary:** teammates. Each runs workflows on their own daemon with their own Pro/Max login, and they share workflow files through git.
- **Not for:**
  - anyone running on someone else's subscription (Anthropic's terms forbid it)
  - users without a Claude subscription
  - other coding agents
  - general SaaS integration automation (n8n's core market)

## Hypothesis
We believe **a from-scratch, n8n-style canvas that runs chained Claude Code nodes (skills, agents, commands, shell steps, branches) on each user's own subscription login** will **remove the re-typing and babysitting of multi-step coding chains** for **coders with large skill libraries**.

We'll know we're right when:
- at least 3 of the owner's real chains run end to end with no typing after Run
- at least 80% of 20 runs succeed
- there are at least 10 runs a week for 4 consecutive weeks
- every node's output and code changes are visible as a diff, and two runs can be compared branch to branch

## Success Metrics
| Metric | Target | How measured |
|---|---|---|
| Real chains running unattended | ≥ 3 workflows; ≥ 80% success over 20 runs | `wf_runs` status |
| Adoption | ≥ 10 runs/week for 4 weeks | `wf_runs` count per week |
| Change visibility | 100% of nodes that change files show their diff; 100% show their text output; any two runs of a workflow can be compared | spot-check 20 runs |
| Stays on the subscription | 0 runs billed to an API key; 0 runs charged to extra usage unless the setting allows it | `wf_runs.auth`, overage flag |
| Quota honesty | 100% of quota hits end as "quota" with the reset time, and can continue from where they stopped | `wf_runs` |
| Re-typed chains | TBD: baseline is 1 repeated chain a month | the same transcript scan, rerun after 4 weeks |

## Scope

**MVP (milestones 1–4):**
- **Canvas:**
  - Agent, Shell, IF, Merge and Approval nodes.
  - Loops with a visit cap.
  - Parallel branches with a merge.
  - Per-node prompt, model, tools, limits and settings.
- **Triggers:**
  - a Run button
  - `ctc run`
  - a local API call
  - a schedule set on the canvas, which waits while you're working
  - MCP tools, so Claude can start a run and check its status from a chat
- **Safety:**
  - Each run gets its own git branch and worktree.
  - An approval pause comes before any push or PR.
  - Each node has turn and time limits.
  - One run at a time.
  - Runs never re-execute a side effect after a crash.
- **Subscription:**
  - Runs use your own login.
  - A run refuses to start if it would bill an API key.
  - The Claude Code CLI version is pinned.
  - A run stops on extra usage unless you allow it.
  - On a quota hit, the run reports the reset time and offers **Continue when reset** or **Continue now**.
- **Run history:**
  - for each node: input, output, diff, tokens and resumable session id
  - live progress while a run is going
  - **Compare runs**: a git diff between two run branches, for the whole run or for one node
- **Team:** workflow files live in git. Runs are tagged and never feed the router's stats or eval data, including teammates' runs.

**After the MVP (milestones 5–6):**
- team run history (storage is pending)
- container mode
- export to Claude Code's native workflow format

**Out of scope**
- Running anyone else's workflows on one subscription, and any hosted or SaaS mode. Anthropic's terms forbid it.
- The Agent SDK or an API-key execution path.
- A credentials store. Claude keeps its own login, GitHub uses `gh auth`, and the rest comes from the environment.
- External webhooks (GitHub, Linear). They need a public URL and HMAC checks.
- Code, HTTP, Set and Filter nodes. Shell steps and templating cover them.
- Version history, RBAC, a sharing UI and worker scaling.
- A chat trigger.
- MCP sampling.
- Other coding agents.

## Delivery Milestones
| # | Milestone | Outcome | Status | Branch |
|---|---|---|---|---|
| 1 | Run a chain | Build an Agent → Shell → IF workflow, press Run. It runs on your login on its own branch. History shows each node's output, diff, tokens and session. | code done (2026-10-22), committed on `m5-runner-core`; WH2 + PR open | `m5-runner-core` |
| 2 | Loops, approval, continue, compare | Fix → retest loops; pause for Approve before push or PR; continue after a quota hit; compare two runs. | pending | `m5-runner-loops` |
| 3 | Parallel and merge | Fan out (for example, three reviewers) and join. | pending | `m5-runner-parallel` |
| 4 | Hands-free triggers | Schedule on the canvas (waits while you work); start from a Claude chat. | pending | `m5-runner-triggers` |
| 5 | Team runs | Teammates run repo workflows on their own logins; history storage pending. | pending | `m5-runner-team` |
| 6 | Modes and export | Container mode with full bypass; export to native `.claude/workflows/*.js`. | pending | `m5-runner-modes` |

**Milestone 1 progress (2026-10-22)**
- **Built** (committed on `m5-runner-core`, cut from `b9-history-import`):
  - Backend: schema (3 `wf_*` tables, live on Supabase), graph walker, `claude -p` / shell runner, engine, daemon runner task + crash sweep, `/api/runs*`, CLI `ctc run | runs | cancel | runner upgrade`.
  - Frontend: canvas with Agent / Shell / IF nodes, settings panel, Run button, runs list, run page with live status, log, diff and resume command.
- **Tested end to end** on a test daemon (`:18311`):
  - `smoke` runs `done`.
  - Cancel and `kill -9` crash recovery leave no orphan processes.
  - Fake quota and extra-usage runs stop as `quota`.
  - The token cap stops before a node.
  - Two website workflows (coder → check → IF → reviewer, plus a fixer in run 12) built real sites. Run 15 was built and run entirely by hand in the browser, on video.
- **Fixed during testing:**
  - 3 review issues: shell-template injection, host permission bypass, agent names.
  - The token cap counted cache reads and could fail finished runs.
  - The run canvas didn't fit wide graphs.
  - 5 editor bugs: mock fallback on slow saves, new nodes off-screen, scope not following the project, hint over the start node, IF dots too close.
  - `index.html` served without `Cache-Control` (a rebuilt dashboard stayed stale).
- **Open:**
  - WH2: the owner's first real chain, then the PR.
  - Unverified: `ctc runner upgrade`, `on_error: continue`, a real usage-limit message.

## Owner decisions (2026-10-22)
| # | Question | Decision |
|---|---|---|
| 1 | What "diff" means | Each node's diff within a run, **plus Compare runs**: `git diff` between two run branches, for the whole run or for one node's commit. |
| 2 | Usage limit hit | Stop with status `quota`, show "out of usage, resets at …", and offer **Continue when reset** (automatic) or **Continue now**. Continuing resumes the same Claude session in the same worktree. |
| 3 | Max-plan extra usage | Plainly: when the limit is hit, does a headless run stop, or keep going on paid extra usage? Two support pages disagree. Default: **stop**, unless the workflow sets `allow_extra_usage: true`. Detection reads the overage flag in the stream **(unverified)**. |
| 4 | File location and native export | Our files live in `.claude/ctc-workflows/*.yaml`. **Export** to `.claude/workflows/<name>.js` is added (M6). Workflows with an approval node can't be exported, because native workflows can't pause for input. |
| 5 | Unattended permissions | **Both**, as a per-workflow setting: `worktree` (default: edits allowed plus a per-node tool allowlist) or `container` (full bypass inside Docker with your own login mounted in, M6). |
| 6 | Bare mode becoming the default | (a) pin the CLI version, upgrading only through `ctc runner upgrade` after a smoke test; (b) an auth check before every run, failing loudly; (c) add the official opt-out flag once Anthropic ships one; (d) fallback: a `claude setup-token` token **(unverified under bare mode)**. |
| 7 | Nodes per 5-hour window | User setting. Each node is a fresh session with its own context window (up to 1M), but all nodes share **one 5-hour quota**, and each node's ~44k startup tokens count against it. Limits: per-node `max_turns`, per-run `max_run_tokens`; token totals shown per node and per run. |
| 8 | Schedule vs your interactive work | A schedule **waits** while you're active: it holds the fire if a non-runner Claude session was active in the last `idle_wait_min` (default 15). |
| 9 | Do runs feed router stats? | **No.** Runs are tagged and excluded from stats, decisions and eval data. |
| 10 | Team history | **Pending.** Teammates' runs also never feed router stats. |

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Terms breach: one login serves others, or a hosted build ships | Med | High | Local-only execution, own login per user, tokens never stored or relayed; legal advice before commercial use |
| Silent API billing or extra usage | Low | High | Auth check before every run; `apiKeySource` check; overage guard |
| Usage limits run out (shared with interactive use) | High | Med | One run at a time, loop caps, run token cap, schedule waits while you're active, quota stop and continue |
| Unsafe unattended edits | Med | High | Own worktree per run, allowlists, caps, approval before push or PR; container mode for full bypass |
| Side effects repeated after a crash | Med | High | Step row claimed before spawn; crash means failed, never re-run |
| Login expires | Med | Med | Auth check before every run; clear error |
| Claude Code changes underneath (bare mode, preview features) | Med | High | Pinned version; `ctc runner upgrade` smoke test; MVP stays off preview features |
| Scope creep (MVP holds all extras) | High | Med | Milestone 1 alone tests the hypothesis |

---

# Part 2: Research (verified on this host, 2026-10-22)

## Bottom line
1. **It runs on the subscription with no API key.** The daemon starts the installed, unmodified `claude -p --output-format stream-json --verbose` once per node, on the owner's claude.ai login. Smoke run: `success`, `"ok"`.
2. **Policy:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", but products may not "route requests through Free, Pro, or Max plan credentials on behalf of their users" (https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). So execution is local only, one user per login.
3. **Agent SDK:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" (https://code.claude.com/docs/en/agent-sdk/overview). We skip it.
4. **MCP:** Claude Code doesn't support sampling (https://github.com/anthropics/claude-code/issues/1785), and spec 2026-07-28 deprecates it. MCP is used only for per-node tool servers and for the `run_workflow` and `workflow_status` tools.
5. **Hard rules:**
   - Never pass `--bare`; it turns off the login.
   - Remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_SIMPLE` from the child's environment.
   - Give every node an explicit permission policy, because `-p` denies tool calls that aren't approved.
6. **Limits:**
   - A 5-hour window and a weekly window, shared with claude.ai and IDE use.
   - About 44k startup tokens per node with all servers loaded.
   - `-p` fails rather than pausing when it hits a limit; the exit shape is undocumented.

## Execution options
| Option | Subscription? | Verdict |
|---|---|---|
| Spawn the installed `claude -p` stream-json per node | Yes, verified | **Chosen.** Per-node cwd, `--strict-mcp-config --mcp-config`, `--permission-mode`, `--allowedTools`, `--json-schema`, `--session-id`/`--resume`; `--max-turns` is hidden but accepted. |
| Claude Agent SDK | Unverified | Skip. Policy problems, and it uses its own bundled binary. |
| `claude mcp serve` | Yes | Skip. No per-call cwd, permissions or limits. |
| MCP sampling | No | Dead end. |
| Native `.claude/workflows/*.js` (https://code.claude.com/docs/en/workflows) | Yes | Export target only (M6). It can't pause for input. |
| Cloud scheduled tasks (https://code.claude.com/docs/en/routines) | Yes | Not used: runs in the cloud, no local worktree. |
| `claude-code-action` (GitHub Action) | Yes, with an OAuth token | Not built. Already usable for GitHub events. |

## MCP notes
- `--strict-mcp-config` loads only the node's servers. Without it, every run loads 19 servers and about 350 tools, including the user-scoped `claudethecaller` server. Strict mode also stops runs from calling `run_workflow`, which would recurse.
- `--tools` doesn't remove MCP tools; use `--disallowedTools "mcp__*"` for that.
- Strict mode drops `mcpServers` from file-based agents' frontmatter; inline `--agents` JSON keeps them.
- `-p` waits up to `MCP_TIMEOUT` (30 s) for servers to connect.
- Under `--permission-prompts none`, unanswered elicitations are cancelled.
- MCP Tasks are behind a flag that is off on this host. Skip them.

---

# Part 3: Plan

Moved to `PLAN.md` → "Workflow runner (m5)" (decisions, stack, constraints, workflow file, walker rules, data model, API, build order WB1–WB16 / WF1–WF12, still-unverified list).
