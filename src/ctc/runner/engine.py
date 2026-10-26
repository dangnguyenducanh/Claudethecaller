"""Workflow engine (PLAN.md m5 WB4-WB6): submit, claim and walk runs; cancel; the crash sweep.

One runner task per daemon (`run_runner`) claims this login's oldest queued run and walks it with ctc.runner.graph,
one batch at a time (rule 7: ready readonly nodes together, else one writer). Each node gets a wf_steps row inserted
`running` before it spawns (ctc.runner.proc) in the run's
git worktree (~/.claudethecaller/runs/<id>/wt on branch ctc/<wf>-<id>, kept after the run), is committed, and its
outcome lands in the same transaction as the walker state. A crash fails the run and re-runs nothing; a usage limit
parks it as `quota` and an approval node as `waiting`, both off the lane: approve() and resume() (or the runner at the
usage reset) put the run back in the queue, and the next claim walks on from its saved state. A hand-started retry
or run-from (retry()) is a new run whose worktree starts at the from step's pre_sha; a crash still re-runs nothing.
`python -m ctc.runner.engine <workflow.yaml> [--input X]` submits one run and walks it in this process (no daemon).
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import uuid
from asyncio.subprocess import DEVNULL, PIPE
from datetime import UTC, datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ctc.runner.graph import (
    _reach,
    batch,
    complete,
    conditions,
    eval_if,
    eval_switch,
    merge_output,
    ready,
    render,
)
from ctc.runner.proc import (
    RUNS,
    agent_argv,
    child_env,
    kill_containers,
    preflight,
    run_agent,
    run_shell,
    stop,
)
from ctc.runner.schedule import tick

log = logging.getLogger(__name__)
SETTINGS = {"permission": "worktree", "allow_extra_usage": False, "auto_resume": True, "max_run_tokens": None}
DIFF_MAX = 65536
PR_URL = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")
WAKE = asyncio.Event()  # submit() -> run_runner
LOCK = asyncio.Lock()  # rule 7: one node's commit + diff at a time
CONTINUE = "Continue where you left off."  # the prompt of a node resumed after a usage limit
_owner: str | None = None

# A queued run: submit() leaves the retry columns null; retry() sets them (base_sha = the commit its worktree starts at).
# pinned: its nodes with a pin complete with pin.output (editor and CLI starts only; ctc.server.runs.submit_run refuses the rest)
SUBMIT_SQL = """insert into wf_runs (owner, workflow, project_id, file_sha, graph, trigger, input, repo, auto_resume,
  parent_run_id, from_node, to_node, base_sha, pinned)
values (%(owner)s, %(workflow)s, %(project_id)s, %(file_sha)s, %(graph)s, %(trigger)s, %(input)s, %(repo)s, %(auto_resume)s,
  %(parent_run_id)s, %(from_node)s, %(to_node)s, %(base_sha)s, %(pinned)s) returning id"""
# The claim (PLAN.md m5 Queue); wf_runs_one_running rejects a second running run of one owner if two claimers race.
CLAIM_SQL = """update wf_runs set status = 'running', started_at = coalesce(started_at, now())
where id = (select id from wf_runs r where status = 'queued' and owner = %(o)s and (%(id)s::bigint is null or id = %(id)s)
  and not exists (select 1 from wf_runs x where x.owner = r.owner and x.status = 'running')
  order by id limit 1 for update skip locked)
returning *"""
# The step row exists before its process does; no row = a cancel got there first, or this visit already ran. A visit
# that stopped at a usage limit is claimed again (same row, its session_id kept for --resume), never inserted twice.
STEP_SQL = """insert into wf_steps (run_id, node_id, visit, kind, status, input, log_path)
select %(rid)s, %(nid)s, %(visit)s, %(kind)s, 'running', %(input)s, %(log)s
where exists (select 1 from wf_runs where id = %(rid)s and status = 'running')
on conflict (run_id, node_id, visit) do update set status = 'running', error = null, started_at = now(), ended_at = null
  where wf_steps.status = 'quota'
returning id, session_id"""
DONE_SQL = """update wf_steps set status = %(status)s, output = %(output)s, error = %(error)s, session_id = %(session_id)s,
  num_turns = %(num_turns)s, usage = %(usage)s, cost_usd = %(cost_usd)s, permission_denials = %(permission_denials)s,
  overage = %(overage)s, pre_sha = %(pre)s, post_sha = %(post)s, files = %(files)s, diff = %(diff)s, marker = %(marker)s,
  ended_at = case when %(status)s::text = 'waiting' then null else now() end
where id = %(sid)s"""
SKIP_SQL = """insert into wf_steps (run_id, node_id, visit, kind, status, ended_at) values (%s, %s, %s, %s, 'skipped', now())
on conflict do nothing"""
RUN_SQL = """update wf_runs set state = %(state)s, tokens = tokens + %(tokens)s, status = coalesce(%(end)s, status),
  error = coalesce(%(err)s, error), quota_resets_at = coalesce(%(resets)s::timestamptz, quota_resets_at),
  pr_url = coalesce(%(pr)s, pr_url), ended_at = case when %(end)s::text in ('done', 'failed') then now() end
where id = %(rid)s and status = 'running' returning id"""
# WB9: the runner's loop puts quota runs back in the queue once their usage window reset (auto_resume, or Continue).
REQUEUE_SQL = """update wf_runs set status = 'queued', error = null
where owner = %s and status = 'quota' and auto_resume and quota_resets_at <= now()"""


def _j(v):
    return None if v is None else Jsonb(v)


def in_runs(cwd: str | None) -> bool:
    """A run's own claude session: cwd inside any home's ~/.claudethecaller/runs/ (a teammate's too, when their hooks
    reach a shared daemon; matched by name, so a symlinked home also counts). It never feeds the router: no
    suggestion, decision, session, event or extract (PLAN.md m5 decision 9)."""
    return f"/{RUNS.parent.name}/{RUNS.name}/" in f"{cwd or ''}/"


def usage_tokens(usage: dict | None) -> dict[str, int]:
    """The *_tokens counts of a result's usage (input, output, cache creation, cache read), shown per step."""
    return {k: v for k, v in (usage or {}).items() if k.endswith("_tokens") and isinstance(v, int)}


def fresh_tokens(usage: dict | None) -> int:
    """What wf_runs.tokens adds up and max_run_tokens limits: every count but cache reads. Re-reading the cached
    prompt each turn is about 3/4 of a run's raw total (run 12: 468k of 624k) and the cheapest part of it."""
    return sum(v for k, v in usage_tokens(usage).items() if k != "cache_read_input_tokens")


async def owner() -> str | None:
    """This login's email (`claude auth status`): runs are keyed by it. Asked once per process; claims refresh it."""
    global _owner
    if not _owner:
        _owner = (await preflight())["email"]
    return _owner


async def git(cwd: str, *args: str, gd: str | None = None) -> str:
    """`git -C cwd args`, without the repo's hooks: a run's bookkeeping commits must not run (or fail on) them. With gd
    (wt_git_dir()), cwd is a run's worktree and git uses gd, never the worktree's own .git file."""
    p = await asyncio.create_subprocess_exec("git", "-C", cwd, "-c", "core.hooksPath=/dev/null",
                                             *([f"--git-dir={gd}", f"--work-tree={cwd}"] if gd else []), *args,
                                             stdin=DEVNULL, stdout=PIPE, stderr=PIPE)
    out, err = await p.communicate()
    if p.returncode:
        raise RuntimeError(f"git {args[0]}: {err.decode(errors='replace').strip()}")
    return out.decode(errors="replace")


async def wt_git_dir(repo: str, wt: str) -> str:
    """A run worktree's admin dir (<repo's common git dir>/worktrees/<name>), found from the repo side: the run's agents
    can rewrite wt/.git to point git at a planted config whose core.fsmonitor would run on the runner's `git add`."""
    common = Path(repo, (await git(repo, "rev-parse", "--git-common-dir")).strip())
    for d in (common / "worktrees").iterdir():
        if (d / "gitdir").is_file() and Path((d / "gitdir").read_text().strip()) == Path(wt).resolve() / ".git":
            return str(d)
    raise RuntimeError(f"no git worktree entry for {wt} in {common}")


async def git_diff(cwd: str, a: str, b: str, gd: str | None = None) -> dict:
    """{diff (first 64 KB), files [{path, added, deleted}] (numstat; None for binary), truncated}."""
    num = await git(cwd, "diff", "--numstat", a, b, gd=gd)
    files = [{"path": p, "added": None if x == "-" else int(x), "deleted": None if y == "-" else int(y)}
             for x, y, p in (ln.split("\t", 2) for ln in num.splitlines())]
    d = await git(cwd, "diff", a, b, gd=gd)  # ponytail: reads the whole diff to keep 64 KB; stream it if runs make huge diffs
    return {"diff": d[:DIFF_MAX], "files": files, "truncated": len(d) > DIFF_MAX}


async def _set(st, rid: int, **cols) -> None:
    await st.store.execute(f"update wf_runs set {', '.join(f'{k} = %({k})s' for k in cols)} where id = %(rid)s", cols | {"rid": rid})


async def _fail(st, ids: list[int], error: str) -> None:
    """Fail running runs and their running steps. Nothing re-runs (PLAN.md m5 Recovery)."""
    if ids:
        await st.store.execute("update wf_steps set status = 'failed', error = %s, ended_at = now()"
                               " where run_id = any(%s) and status = 'running'", (error, ids))
        await st.store.execute("update wf_runs set status = 'failed', error = %s, ended_at = now()"
                               " where id = any(%s) and status = 'running'", (error, ids))


async def submit(st, owner: str, workflow: str, g: dict, file_sha: str, repo: str, project_id: str | None = None,
                 trigger: str = "api", text: str = "", pinned: bool = False) -> int:
    """Queue a run of a validated graph (the snapshot it will walk) and wake the runner. pinned: nodes with a pin
    complete with pin.output, no process and no commit (execute())."""
    rid = await st.store.fetchval(SUBMIT_SQL, {
        "owner": owner, "workflow": workflow, "project_id": project_id, "file_sha": file_sha, "graph": Jsonb(g),
        "trigger": trigger, "input": text, "repo": repo, "auto_resume": _auto_resume(g), "parent_run_id": None,
        "from_node": None, "to_node": None, "base_sha": None, "pinned": pinned})
    WAKE.set()
    return rid


def _auto_resume(g: dict) -> bool:
    return bool((SETTINGS | (g.get("settings") or {}))["auto_resume"])


async def retry(st, owner: str, parent_id: int, g: dict, file_sha: str, from_node: str | None = None,
                to_node: str | None = None, trigger: str = "api") -> int:
    """Queue a new run of g (the workflow as saved now) linked to run parent_id, from its failed step (retry, the
    default when it failed), from_node, or the start; to_node stops it with done after that node. The parent's steps
    before the from step are copied as `reused` (execute() completes them with their outputs: no process, 0 tokens) and
    the child's worktree starts at the from step's pre_sha. ValueError with a user-facing message on every refusal."""
    p = await st.store.fetchrow("select * from wf_runs where id = %s and owner = %s", (parent_id, owner))
    if not p:
        raise ValueError(f"no run {parent_id}")
    if p["status"] in ("queued", "running", "waiting", "quota"):
        raise ValueError(f"run {parent_id} is {p['status']}: cancel it or let it end first")
    for x in (from_node, to_node):
        if x is not None and x not in {n["id"] for n in g["nodes"]}:
            raise ValueError(f"{x} is not a node of {p['workflow']} as saved now")
    trig = next(n["id"] for n in g["nodes"] if n["type"] == "trigger")
    steps = await st.store.fetch("select id, node_id, visit, status, output, pre_sha, post_sha from wf_steps"
                                 " where run_id = %s order by id", (parent_id,))
    frm = None  # the parent step the child starts at; None = from the start
    if from_node is None and p["status"] == "failed":  # retry: the step that failed the run (that visit, in a loop)
        frm = next((s for s in reversed(steps) if s["status"] in ("failed", "timeout")), None)
    elif from_node not in (None, trig) and not (
            frm := next((s for s in steps if s["node_id"] == from_node and s["status"] != "skipped"), None)):
        raise ValueError(f"{from_node} never ran in run {parent_id}" + ("" if steps else "; its steps were pruned"))
    from_node = frm["node_id"] if frm else trig
    if to_node and to_node not in _reach(from_node, [(e["from"], e["to"]) for e in g["edges"]]):
        raise ValueError(f"{to_node} does not come after {from_node}")
    reused = [s for s in steps if frm and s["id"] < frm["id"] and s["status"] in ("done", "failed") and s["output"] is not None]
    sha = ((frm or {}).get("pre_sha") or next((s["post_sha"] for s in reversed(reused) if s["post_sha"]), None)
           or p["base_sha"])
    if not sha:
        raise ValueError(f"run {parent_id} never started: nothing to reuse")
    try:
        await git(p["repo"], "cat-file", "-e", f"{sha}^{{commit}}")
    except RuntimeError:
        raise ValueError(f"run {parent_id}'s commit {sha[:12]} is gone (pruned?): start a fresh run") from None

    async def go(conn):
        async with conn.transaction():  # the child and its reused steps land together, before the runner can claim it
            rid = (await (await conn.execute(SUBMIT_SQL, {
                "owner": owner, "workflow": p["workflow"], "project_id": p["project_id"], "file_sha": file_sha,
                "graph": Jsonb(g), "trigger": trigger, "input": p["input"], "repo": p["repo"], "auto_resume": _auto_resume(g),
                "parent_run_id": parent_id, "from_node": from_node, "to_node": to_node, "base_sha": sha,
                "pinned": False})).fetchone())["id"]
            # usage and cost_usd stay null: reused nodes cost 0 tokens
            await conn.execute(
                "insert into wf_steps (run_id, node_id, visit, kind, status, input, output, error, session_id, num_turns,"
                " pre_sha, post_sha, files, diff, log_path, started_at, ended_at, marker)"
                " select %s, node_id, visit, kind, 'done', input, output, error, session_id, num_turns, pre_sha, post_sha,"
                " files, diff, log_path, started_at, ended_at, 'reused' from wf_steps where id = any(%s)",
                (rid, [s["id"] for s in reused]))
            return rid
    rid = await st.store._run(go)
    WAKE.set()
    return rid


async def claim(st, run_id: int | None = None) -> dict | None:
    """This login's oldest queued run (or run_id), now `running` in its worktree; None when there is none, another run
    of this owner is running, or the run ended at the gate: the owner's usage window is still closed (-> quota, no
    spawn) or claude is unusable (-> failed)."""
    global _owner
    if not (o := await owner()):
        return None
    try:
        run = await st.store.fetchrow(CLAIM_SQL, {"o": o, "id": run_id})
    except psycopg.errors.UniqueViolation:  # a second claimer won the race past `not exists`
        return None
    if not run:
        return None
    rid = run["id"]
    # the gate: no spawn while a run of this owner waits for a usage reset, unless this run is past its own reset
    # (re-queued at the reset, or continued now: resume() sets it to now)
    if resets := await st.store.fetchval(
            "select max(quota_resets_at) from wf_runs where owner = %(o)s and quota_resets_at > now()"
            " and not exists (select 1 from wf_runs where id = %(id)s and quota_resets_at <= now())", {"o": o, "id": rid}):
        await _set(st, rid, status="quota", quota_resets_at=resets, error=f"usage limit: waiting for the reset at {resets.isoformat()}")
        return None
    pre = await preflight((run["graph"].get("settings") or {}).get("permission") == "container")  # in the image too
    _owner = pre["email"] or _owner
    cols = {"auth": Jsonb({k: pre[k] for k in ("authMethod", "email", "claude_version")})}
    err = pre["error"] or (None if pre["email"] == o else f"claude is logged in as {pre['email']}; this run belongs to {o}")
    if not err and not run["worktree"]:  # first start: its own branch and worktree, never the user's checkout
        wt, branch = RUNS / str(rid) / "wt", f"ctc/{run['workflow'].rpartition(':')[2]}-{rid}"
        try:
            wt.parent.mkdir(parents=True, exist_ok=True)
            # a retry child starts at its seed commit (its base_sha), so the run diff shows only its own changes
            await git(run["repo"], "worktree", "add", "-q", "-b", branch, str(wt), run["base_sha"] or "HEAD")
            cols |= {"worktree": str(wt), "branch": branch, "base_sha": (await git(str(wt), "rev-parse", "HEAD")).strip()}
        except (OSError, RuntimeError) as e:
            err = str(e)
    if err:
        await _set(st, rid, **cols, status="failed", error=err, ended_at=datetime.now(UTC))
        return None
    await _set(st, rid, **cols)
    return run | cols


async def _save(st, steps: list[dict], skipped: list[tuple], run: dict) -> bool:
    """One transaction: a batch's step outcomes, newly skipped nodes, and the run's walker state, tokens and end.
    False when the run is no longer `running` (cancel() got there first): the steps are recorded `cancelled`."""
    async def go(conn):
        async with conn.transaction():
            ok = await (await conn.execute(RUN_SQL, run)).fetchone() is not None
            for step in steps:
                await conn.execute(DONE_SQL, step if ok else step | {"status": "cancelled"})
            if ok and skipped:
                async with conn.cursor() as cur:
                    await cur.executemany(SKIP_SQL, skipped)
            return ok
    # ponytail: _run retries on a connection the pooler dropped while a node ran; a cut between commit and reply re-adds tokens
    return await st.store._run(go)


def _gzip(p: Path) -> None:
    tmp = p.with_name(p.name + ".gz.tmp")
    with p.open("rb") as f, gzip.open(tmp, "wb") as z:
        shutil.copyfileobj(f, z)
    tmp.replace(p.with_name(p.name + ".gz"))  # the log endpoint reads .gz once it exists, so it is whole before the rename
    p.unlink()


def _reopen(p: Path, argv: list[str]) -> None:
    """A continued node's log: its first try (gunzipped back, so the log endpoint reads the live file), then a ctc line
    with the resume argv; the new stream-json lines follow."""
    gz = p.with_name(p.name + ".gz")
    with p.open("ab") as f:
        if gz.exists():
            with gzip.open(gz) as z:
                shutil.copyfileobj(z, f)
        f.write(json.dumps({"type": "ctc", "subtype": "continue", "argv": argv}).encode() + b"\n")
    gz.unlink(missing_ok=True)


def _input(node: dict, ctx: dict, resume: str | None) -> tuple[str, list[str] | None]:
    """(step input, agent argv): the rendered prompt or command, what an IF or switch tests, an approval's message, or the
    trigger's input."""
    if node["type"] == "agent":
        argv, text = agent_argv(node, ctx, str(uuid.uuid4()), resume=resume)
        return text, argv
    if node["type"] == "shell":
        return render(node["command"], ctx, shell=True), None
    if node["type"] in ("if", "switch"):
        def conds(n: dict) -> str:
            return f" {n.get('combine') or 'and'} ".join(f"{c.get('path')} {c.get('op')} {c.get('value')!r}" for c in conditions(n))
        if node["type"] == "if":
            return conds(node), None
        return "; ".join([*(f"{c.get('name')}: {conds(c)}" for c in node.get("cases") or []), "else default"]), None
    if node["type"] == "approval":
        return render(node.get("message") or "", ctx), None
    if node["type"] == "merge":  # its inputs are the joined nodes' outputs, shown as the step's output
        return "", None
    return ctx["input"], None


async def _spawn(node: dict, text: str, argv: list[str] | None, ctx: dict, wt: str, gd: str, log_path: Path | None,
                 env: dict, s: dict) -> dict:
    """Run one node -> a proc-style result. Agent and shell nodes are committed (empty or not) after they run."""
    if node["type"] == "trigger":
        return {"status": "done", "output": {"input": text}}
    if node["type"] == "if":
        return {"status": "done", "output": {"value": eval_if(node, ctx)}}
    if node["type"] == "switch":
        return {"status": "done", "output": {"case": eval_switch(node, ctx)}}
    if node["type"] == "approval":  # nothing runs: the run waits off the lane for approve()
        return {"status": "waiting"}
    timeout = node.get("timeout_s") or 1800
    if argv:
        res = await run_agent(argv, text, wt, str(log_path), timeout, env, bool(s["allow_extra_usage"]),
                              f"ctc-run-{env['CTC_RUN']}-{node['id']}-{node['visit']}" if s["permission"] == "container" else None)
    else:
        res = await run_shell(text, wt, timeout, env)
    async with LOCK:  # pre read here too: a batch sibling may have committed while this node ran
        pre = (await git(wt, "rev-parse", "HEAD", gd=gd)).strip()
        await git(wt, "add", "-A", gd=gd)
        await git(wt, "commit", "-q", "--allow-empty", "-m", f"ctc: {node['id']}#{node['visit']}", gd=gd)
        post = (await git(wt, "rev-parse", "HEAD", gd=gd)).strip()
        d = await git_diff(wt, pre, post, gd)
    return res | {"pre_sha": pre, "post_sha": post, "files": d["files"], "diff": d["diff"]}


async def execute(st, run: dict) -> None:
    """Walk a claimed run to its end (done, failed, cancelled from outside by cancel()) or to a pause off the lane
    (quota, waiting). A resumed run walks on from its saved state, its done nodes' outputs read back for templates.
    Rule 7: a batch is every ready readonly node, run together under asyncio.gather, else the first ready writer alone.
    ponytail: a batch is saved when its slowest node ends, and a failing node's siblings run on to their own end;
    save each node as it lands (and stop the siblings) if long readonly agents make that costly."""
    rid, g, wst, wt = run["id"], run["graph"], run["state"], run["worktree"]
    s = SETTINGS | (g.get("settings") or {})
    nodes = {n["id"]: (g.get("defaults") or {}) | n for n in g["nodes"]}
    trig = next(n for n in g["nodes"] if n["type"] == "trigger")
    ctx = {"input": run["input"] or trig.get("input") or "", "run": {"branch": run["branch"]}}
    env, sessions, total, seen = child_env() | {"CTC_RUN": str(rid)}, {}, run["tokens"], len(wst.get("skipped", []))

    def skips() -> list[tuple]:  # nodes the walker skipped since the last save -> their step rows
        nonlocal seen
        new, seen = wst["skipped"][seen:], len(wst["skipped"])
        return [(rid, n, wst["visits"][n], nodes[n]["type"]) for n in new]

    async def spawn(node: dict, text: str, argv: list[str] | None, log_path: Path | None, canned: dict | None) -> dict:
        if canned:  # completed without executing: no process, no commit, no pre/post sha
            return canned
        if node["type"] == "merge":  # its inputs are the data tokens in its inbox, which complete() clears
            return {"status": "done", "output": merge_output(g, wst, node["id"], ctx)}
        return await _spawn(node, text, argv, ctx, wt, gd, log_path, env, s)

    try:
        gd = await wt_git_dir(run["repo"], wt)
        for row in await st.store.fetch("select node_id, output, session_id from wf_steps where run_id = %s"
                                        " and status in ('done', 'failed') and output is not null order by id", (rid,)):
            ctx[row["node_id"]], sessions[row["node_id"]] = row["output"], row["session_id"]
        # a retry child's steps copied from its parent (retry()): the walker completes them with the parent's outputs
        reused = {(r["node_id"], r["visit"]): r for r in await st.store.fetch(
            "select id, node_id, visit, output, session_id from wf_steps where run_id = %s and marker = 'reused'", (rid,))}
        if not (r := ready(g, wst)):  # approved with nothing left to run: what quiescence skipped, then done
            await _save(st, [], skips(), {"rid": rid, "state": Jsonb(wst), "tokens": 0, "end": "done", "err": None,
                                          "resets": None, "pr": None})
            return
        while r:
            b = batch(g, r)
            if s["max_run_tokens"] and total >= s["max_run_tokens"]:  # checked before a batch, so finished work is never failed
                await _fail(st, [rid], f"max_run_tokens reached before {', '.join(b)}: {total} >= {s['max_run_tokens']}")
                return
            jobs = []  # (step id, node, input text, argv, log path, canned): every row is inserted `running` before any spawn
            for nid in b:
                node = nodes[nid] | {"visit": wst["visits"].get(nid, 0) + 1}
                if row := reused.get((nid, node["visit"])):  # its copied row is final: no input, no insert, no log
                    jobs.append((row["id"], node, None, None, None, {"status": "done", "output": row["output"],
                                                                      "session_id": row["session_id"], "marker": "reused"}))
                    continue
                # a pinned run completes a pinned node with its pin: its input is kept, no argv, log, process or commit
                pin = {"status": "done", "output": node["pin"]["output"], "marker": "pinned"} if (
                    run.get("pinned") and node.get("pin")) else None
                log_path = RUNS / str(rid) / f"{nid}-{node['visit']}.jsonl" if node["type"] == "agent" and not pin else None
                text, argv = _input(node, ctx, sessions.get(node.get("resume_from")))
                argv = None if pin else argv
                row = await st.store.fetchrow(STEP_SQL, {"rid": rid, "nid": nid, "visit": node["visit"], "kind": node["type"],
                                                         "input": text, "log": str(log_path) if log_path else None})
                if not row:
                    if await st.store.fetchval("select status from wf_runs where id = %s", (rid,)) == "running":
                        raise RuntimeError(f"step {nid}#{node['visit']} already exists")
                    return  # cancelled between two batches; cancel() also marked this batch's earlier rows
                if argv and row["session_id"]:  # WB9: this visit stopped at a usage limit; go on in its own session
                    argv, text = agent_argv(node, ctx, None, resume=row["session_id"])[0], CONTINUE
                    await asyncio.to_thread(_reopen, log_path, argv)
                jobs.append((row["id"], node, text, argv, log_path, pin))
            # ponytail: a cancel landing between the row inserts and the spawns misses these processes; they run to their end
            ress = await asyncio.gather(*(spawn(*j[1:]) for j in jobs), return_exceptions=True)
            if exc := next((x for x in ress if isinstance(x, BaseException)), None):
                raise exc  # after every sibling ended, so none is left running past the run's failure
            steps, tok, end, err, resets, pr, stops, done = [], 0, None, None, None, None, [], []
            for (sid, node, *_), res in zip(jobs, ress):
                nid, out = node["id"], res.get("output")
                tok += fresh_tokens(res.get("usage"))
                if res["status"] == "done" or (res["status"] == "failed" and out and node.get("on_error") == "continue"):
                    ctx[nid], sessions[nid] = out, res.get("session_id")
                    err = err or complete(g, wst, nid, out)  # a loop over its max_visits fails the run
                    done.append(nid)
                elif res["status"] == "waiting":  # an approval (always alone): the run leaves the lane until approve()
                    end = "waiting"
                else:  # failed, timeout, quota (usage limit or extra usage): the run stops after this batch
                    stops.append((nid, res))
                if res.get("marker") == "reused":  # its copied row is final; DONE_SQL would null its shas
                    continue
                if node["type"] == "shell" and not res.get("marker") and (m := PR_URL.search((out or {}).get("stdout_tail") or "")):
                    pr = m.group(0)
                steps.append({"sid": sid, "status": res["status"], "output": _j(out), "error": res.get("error"),
                              "session_id": res.get("session_id"), "num_turns": res.get("num_turns"),
                              "usage": _j(res.get("usage")), "cost_usd": res.get("cost_usd"),
                              "permission_denials": _j(res.get("permission_denials")), "overage": res.get("overage"),
                              "pre": res.get("pre_sha"), "post": res.get("post_sha"), "files": _j(res.get("files")),
                              "diff": res.get("diff"), "marker": res.get("marker")})
            total += tok
            fails = [f"{nid}: {res.get('error') or res['status']}" for nid, res in stops if res["status"] != "quota"]
            quota = next((res for _, res in stops if res["status"] == "quota"), None)
            r = []
            if err or fails:  # a failure wins over a sibling's usage limit; the batch's done siblings stay done
                end, err = "failed", err or fails[0]
            elif quota:  # continue re-claims just the quota node: its done siblings were completed above
                end, err, resets = "quota", quota.get("error"), quota.get("resets_at")
            elif not end and run.get("to_node") in done:  # run-to: stop cleanly right after that node
                end = "done"
            elif not end:
                r = ready(g, wst)
                end = None if r else "done"
            saved = await _save(st, steps, skips(), {"rid": rid, "state": Jsonb(wst), "tokens": tok, "end": end,
                                                     "err": err, "resets": resets, "pr": pr})
            for *_, log_path, _ in jobs:
                if log_path and log_path.exists():
                    await asyncio.to_thread(_gzip, log_path)
            if not saved:
                return
    except Exception as e:  # git, DB, a broken snapshot: fail it, never retry. CancelledError (shutdown) goes to sweep()
        log.exception("run %s: runner error", rid)
        await _fail(st, [rid], f"runner error: {type(e).__name__}: {e}")


async def kill_run(rid: int) -> None:
    """stop() every process group holding a process started for this run (CTC_RUN=<id> in /proc/<pid>/environ): its
    nodes and whatever they left behind, also after a daemon crash. Never this process's own group."""
    tag, groups = f"CTC_RUN={rid}".encode(), set()
    for env in Path("/proc").glob("[0-9]*/environ"):
        try:
            if tag in env.read_bytes().split(b"\0"):
                groups.add(os.getpgid(int(env.parent.name)))
        except OSError:  # exited meanwhile, or another user's process
            pass
    groups.discard(os.getpgrp())
    await asyncio.gather(*(stop(pg) for pg in groups), kill_containers(f"ctc-run-{rid}-"))  # + container-mode nodes


async def cancel(st, rid: int, owner: str) -> None:
    """queued/waiting/quota -> cancelled (a row update); running -> cancelled, then stop() its node processes. The walker
    finds the run no longer `running` when the node returns, records the step `cancelled` and stops."""
    if await st.store.execute("update wf_runs set status = 'cancelled', ended_at = now()"
                              " where id = %s and owner = %s and status in ('queued', 'running', 'waiting', 'quota')", (rid, owner)):
        await st.store.execute("update wf_steps set status = 'cancelled', ended_at = now()"
                               " where run_id = %s and status in ('running', 'waiting')", (rid,))
        await kill_run(rid)


async def approve(st, rid: int, owner: str, ok: bool, note: str | None) -> bool:
    """POST /approve on a `waiting` run: approved -> its approval step `done` {approved: true, note}, the walker moves
    past it, and the run goes back to `queued` (the runner re-claims it and walks on from its state); rejected -> the
    step and the run `cancelled`. False when the run is not waiting."""
    w = await st.store.fetchrow("select r.graph, r.state, s.id, s.node_id from wf_runs r join wf_steps s on s.run_id = r.id"
                                " and s.status = 'waiting' where r.id = %s and r.owner = %s and r.status = 'waiting'", (rid, owner))
    if not w:
        return False
    wst, out = w["state"], {"approved": ok, "note": note}
    if ok:
        complete(w["graph"], wst, w["node_id"], out)  # never a loop error: validate keeps approvals out of loops

    async def go(conn):
        async with conn.transaction():  # the run row first: a second approve() waits on its lock, then finds it moved on
            if not await (await conn.execute(
                    "update wf_runs set status = %s, state = %s, ended_at = case when %s then null else now() end"
                    " where id = %s and status = 'waiting' returning id", ("queued" if ok else "cancelled", Jsonb(wst), ok, rid))).fetchone():
                return False
            await conn.execute("update wf_steps set status = %s, output = %s, ended_at = now() where id = %s",
                               ("done" if ok else "cancelled", Jsonb(out), w["id"]))
            return True
    if done := await st.store._run(go):
        WAKE.set()
    return done


async def resume(st, rid: int, owner: str, now: bool) -> bool:
    """POST /continue on a `quota` run: now -> `queued` at once, past the claim's quota gate (its own reset is set to
    now); else auto_resume, so the runner re-queues it once its quota_resets_at passes. False when it is not `quota`.
    ponytail: a quota run with no quota_resets_at (the reset text did not parse) only goes on with now."""
    sql = "status = 'queued', quota_resets_at = now(), error = null" if now else "auto_resume = true"
    if n := await st.store.execute(f"update wf_runs set {sql} where id = %s and owner = %s and status = 'quota'", (rid, owner)):
        WAKE.set()  # also re-queues at once a run whose reset already passed
    return bool(n)


async def sweep(st, error: str = "daemon stopped mid-run") -> None:
    """No runner walks this owner's `running` runs now (daemon start, or shutdown after the runner task stopped): stop
    what their nodes left running, then fail them and their running steps."""
    if not (o := await owner()):
        return
    ids = [r["id"] for r in await st.store.fetch("select id from wf_runs where owner = %s and status = 'running'", (o,))]
    for rid in ids:
        await kill_run(rid)
    await _fail(st, ids, error)


async def run_runner(st) -> None:
    """Daemon task (local mode): sweep() what a dead daemon left, then walk queued runs one at a time. submit(),
    approve() and resume() wake it; a 30 s poll catches runs queued by another process and quota runs whose usage
    window reset (REQUEUE_SQL), and fires due schedules (ctc.runner.schedule.tick)."""
    while True:
        try:
            await sweep(st)
            break
        except Exception:
            log.exception("runner: startup sweep failed; retrying in 30 s")
            await asyncio.sleep(30)
    while True:
        wait = 30.0
        try:
            await st.store.execute(REQUEUE_SQL, (await owner(),))
            wait = await tick(st, await owner())  # WB12: fire due schedules; wake just after the next cron slot
            while run := await claim(st):
                await execute(st, run)
        except Exception:
            log.exception("runner: claim failed")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(WAKE.wait(), wait)
        WAKE.clear()


if __name__ == "__main__":
    import argparse
    import sys

    from ctc.ingestion.scanner import project_id, project_namespace
    from ctc.runner.graph import load, validate
    from ctc.server.state import close_state, open_state

    ap = argparse.ArgumentParser(prog="python -m ctc.runner.engine", description="Submit one run and walk it here.")
    ap.add_argument("workflow", help="a workflow file, e.g. .claude/ctc-workflows/smoke.yaml")
    ap.add_argument("--input", default="")
    a = ap.parse_args()

    async def main() -> int:
        path = Path(a.workflow).resolve()
        g = load(path)
        if errs := validate(g):
            print("invalid graph:", errs)
            return 1
        repo = (await git(str(path.parent), "rev-parse", "--show-toplevel")).strip()
        st = await open_state()
        try:
            if not (o := await owner()):
                print("claude auth status shows no login")
                return 1
            rid = await submit(st, o, f"{project_namespace(repo)}:{g.get('name') or path.stem}", g,
                               hashlib.sha256(path.read_bytes()).hexdigest(), repo, project_id(repo), "cli", a.input)
            if run := await claim(st, rid):
                try:
                    await execute(st, run)
                except BaseException:  # Ctrl-C: its nodes are stopped by proc; the run must not stay `running`
                    await _fail(st, [rid], "runner stopped mid-run")
                    raise
            r = await st.store.fetchrow("select * from wf_runs where id = %s", (rid,))
            print(f"run {rid} {r['status']} branch={r['branch']} tokens={r['tokens']} quota_resets_at={r['quota_resets_at']}"
                  f" error={r['error']!r}")
            for s in await st.store.fetch("select node_id, visit, status, error from wf_steps where run_id = %s order by id", (rid,)):
                print(f"  {s['node_id']}#{s['visit']} {s['status']}" + (f"  {s['error'][:200]!r}" if s["error"] else ""))
            return 0 if r["status"] == "done" else 1
        finally:
            await close_state(st)

    sys.exit(asyncio.run(main()))
