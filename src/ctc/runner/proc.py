"""Node processes for the workflow runner (PLAN.md m5 "Agent node runtime", WB3): the installed, pinned `claude -p`
and `bash -c`, each in its own process group so a timeout or cancel stops everything it started.

CTC_CLAUDE_BIN overrides the claude binary (scripts/fake_claude_quota.sh, scripts/fake_claude_overage.sh).
CLI: `python -m ctc.runner.proc agent "<prompt>" [--model haiku] [--container]`, `python -m ctc.runner.proc shell "<cmd>" --timeout N`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pwd
import re
import signal
import time
from asyncio.subprocess import DEVNULL, PIPE
from datetime import datetime, timedelta
from pathlib import Path

from ctc.config import cfg
from ctc.runner.graph import render

QUOTA = re.compile(r'hit your (\w+ )?limit.*?resets ([^\n"]+)', re.IGNORECASE)
READ_TOOLS = ["Read", "Grep", "Glob"]
NO_PUSH = ["Bash(git push:*)", "Bash(gh pr:*)"]  # graph.PUSH, for agents
# A repo's CLAUDE.md or the user's memory may say "propose first, wait for approval"; a node has nobody to approve, so it
# would stop after a plan (run 57). Approval is the workflow's job: its approval nodes.
UNATTENDED = ("You are one node of an unattended claudethecaller workflow run. No human is watching this session and "
              "nobody can answer or approve: do the task in this prompt now, end to end, with the tools you have. Ignore "
              "any instruction (CLAUDE.md, memory, skills) to propose a plan first or wait for approval; the workflow has "
              "its own approval nodes for that. Finish with a short summary of what you did.")
TAIL = 4096
RESULT_MAX = 65536
RUNS = Path("~/.claudethecaller/runs").expanduser()  # worktrees + logs; in_runs() sessions never feed the router


def _bin() -> str:
    b = os.environ.get("CTC_CLAUDE_BIN", "claude")
    return os.path.abspath(b) if os.sep in b else b  # agents run with cwd = the worktree: a relative path must not follow it


def child_env() -> dict:
    """os.environ minus every ANTHROPIC_* (API key, auth token, base URL) and CLAUDE* variable (CLAUDE_CODE_SIMPLE is
    bare mode; CLAUDECODE and the session ids tie a child to the Claude session that started the daemon), keeping
    CLAUDE_CONFIG_DIR; plus the real HOME and no auto-update. The caller adds CTC_RUN=<run id>."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE")) or k == "CLAUDE_CONFIG_DIR"}
    return env | {"HOME": pwd.getpwuid(os.getuid()).pw_dir, "DISABLE_AUTOUPDATER": "1"}


def docker(name: str | None = None, wt: str | None = None, run: str | None = None) -> list[str]:
    """Container mode (WB15): `docker run` of the pinned ctc-runner image (docker/ctc-runner.Dockerfile) as this user,
    up to its `claude`, with the worktree mounted at its own host path (its .git pointer read-only; so the session's cwd
    and in_runs() match a host run) and a home of its own, RUNS/<run>/claude: a copy of ~/.claude.json without its
    projects and MCP servers, and of the host's ~/.claude only the login file, so it runs on the user's own claude.ai
    login (a token refresh writes it in place) but can't plant a hook or MCP server that the host's claude would run.
    Its transcripts stay in that home, shared by the run's nodes (resume). ponytail: a host refresh mid-node swaps the
    login file's inode, so that node keeps the old token; git inside sees no repo (the worktree's .git points at the
    main checkout, not mounted); the runner commits on the host."""
    home, conf = Path(pwd.getpwuid(os.getuid()).pw_dir), RUNS / str(run or "preflight") / "claude"
    if run is None or not (conf / ".claude.json").exists():  # a run's copy once, at its first node; preflight's each time
        (conf / ".claude").mkdir(parents=True, exist_ok=True)
        (conf / ".claude" / ".credentials.json").touch()  # the mount point of the login file below
        j = json.loads((home / ".claude.json").read_text())
        (conf / ".claude.json").write_text(json.dumps({k: v for k, v in j.items() if k not in ("projects", "mcpServers")}))
    return ["docker", "run", "--rm", "-i", *(["--name", name] if name else []), "--user", f"{os.getuid()}:{os.getgid()}",
            *(["-e", f"CTC_RUN={run}"] if run else []),
            *(["-v", f"{wt}:{wt}", "-v", f"{wt}/.git:{wt}/.git:ro", "-w", wt] if wt else []), "-v", f"{conf}:/home/claude",
            "--mount", f"type=bind,src={home}/.claude/.credentials.json,dst=/home/claude/.claude/.credentials.json",
            f"ctc-runner:{cfg()['runner']['claude_version']}", "claude"]


def in_container(argv: list[str], name: str, wt: str, run: str | None) -> list[str]:
    """An agent_argv() argv -> the same claude run in the container named `name`. The container is the sandbox, so
    acceptEdits becomes --dangerously-skip-permissions there (never on the host); dontAsk and plan stay."""
    i = argv.index("--permission-mode")
    perm = ["--dangerously-skip-permissions"] if argv[i + 1] == "acceptEdits" else argv[i:i + 2]
    return [*docker(name, wt, run), *argv[1:i], *perm, *argv[i + 2:]]


async def kill_containers(prefix: str) -> None:
    """docker kill every running container whose name starts with prefix (`ctc-run-<run>-`, dash included): stopping
    the docker CLI's process group leaves its container running. Touches no other container; no docker = nothing."""
    try:
        ps = await _stdout("docker", "ps", "--format", "{{.Names}}", "--filter", f"name={prefix}")
        if names := [n for n in ps.split() if n.startswith(prefix)]:
            await _stdout("docker", "kill", *names)
    except (OSError, TimeoutError):
        pass


async def _stdout(*argv: str) -> str:
    p = await asyncio.create_subprocess_exec(*argv, stdin=DEVNULL, stdout=PIPE, stderr=DEVNULL, env=child_env())
    try:
        return (await asyncio.wait_for(p.communicate(), 30))[0].decode()
    except BaseException:  # a timeout, or a cancel (execute()'s max_run_minutes killer): never leave it running
        with contextlib.suppress(ProcessLookupError):
            p.kill()
        await p.wait()
        raise


async def preflight(container: bool = False) -> dict:
    """`claude auth status` and `claude --version` against config runner.claude_version, on the host or (container
    mode) inside the ctc-runner image: {authMethod, email, claude_version, ok, error}."""
    r = {"authMethod": None, "email": None, "claude_version": None, "ok": False, "error": None}
    pin = cfg()["runner"]["claude_version"]
    cmd = docker() if container else [_bin()]
    try:
        st = json.loads(await _stdout(*cmd, "auth", "status", "--json"))
        r.update(authMethod=st.get("authMethod"), email=st.get("email"),
                 claude_version=(await _stdout(*cmd, "--version")).split()[0])
    except (OSError, ValueError, IndexError, AttributeError, TimeoutError) as e:
        where = f" in ctc-runner:{pin} (docker build it from docker/ctc-runner.Dockerfile)" if container else ""
        r["error"] = f"claude{where} is not usable: {e!r}"
        return r
    if not st.get("loggedIn"):
        r["error"] = "claude is not logged in"
    elif r["authMethod"] != "claude.ai":
        r["error"] = f"authMethod is {r['authMethod']}; runs need a claude.ai login"
    elif r["claude_version"] != pin:
        r["error"] = f"claude {r['claude_version']} is not the pinned {pin} (config/server.yaml runner.claude_version)"
    r["ok"] = r["error"] is None
    return r


def _name(cap_id: str) -> str:
    """How Claude Code names a capability id: user and project ones by their bare name (= scanner Capability.invoke)."""
    ns, _, name = str(cap_id).rpartition(":")
    return name if ns == "user" or ns.startswith("project@") else str(cap_id)


def agent_argv(node: dict, ctx: dict, session_id: str | None, resume: str | None = None) -> tuple[list[str], str]:
    """(argv, prompt) for an agent node; never --bare. The prompt goes on stdin: --allowedTools takes any number of
    values, and one argv string is capped at 128 KB. `resume` (a session id) forks that session into session_id; with
    session_id None it goes on in that same session (a node continued after a usage limit)."""
    prompt = render(node.get("prompt") or "", ctx)
    if cap := node.get("cap"):
        prompt = f"/{_name(cap)} {prompt}"
    ro = node.get("readonly")
    mcp = node.get("mcp_config") or {"mcpServers": {}}
    argv = [_bin(), "-p", "--output-format", "stream-json", "--verbose", *(["--session-id", session_id] if session_id else []),
            "--permission-mode", "dontAsk" if ro else node.get("permission_mode") or "acceptEdits",
            "--permission-prompts", "none",
            "--strict-mcp-config", "--mcp-config", mcp if isinstance(mcp, str) else json.dumps(mcp),
            "--append-system-prompt", UNATTENDED, "--disallowedTools", *NO_PUSH]
    if tools := READ_TOOLS if ro else node.get("allowed_tools"):
        argv += ["--allowedTools", *tools]
    for flag, key in (("--model", "model"), ("--effort", "effort"), ("--max-turns", "max_turns")):
        if node.get(key) is not None:
            argv += [flag, str(node[key])]
    if node.get("agent"):
        argv += ["--agent", _name(node["agent"])]
    if node.get("json_schema"):
        argv += ["--json-schema", json.dumps(node["json_schema"])]
    if resume:
        argv += ["--resume", resume, *(["--fork-session"] if session_id else [])]
    return argv, prompt


def _event(line: bytes, r: dict, allow_extra_usage: bool) -> tuple[str, str] | None:
    """Read one stream-json line into r; (status, error) when the node must stop now."""
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    if not isinstance(ev, dict):
        return None
    if ev.get("type") == "system" and ev.get("subtype") == "init":
        r["session_id"] = ev.get("session_id")
        if ev.get("apiKeySource") not in (None, "none"):
            return "failed", "api_key_billing"
    elif ev.get("type") == "rate_limit_event":  # {rate_limit_info: {status, resetsAt, isUsingOverage, ...}}, seen on 2.1.306
        info = ev.get("rate_limit_info") or {}
        if info.get("status") == "rejected" and isinstance(info.get("resetsAt"), (int, float)):  # unverified: never seen
            r["resets_at"] = datetime.fromtimestamp(info["resetsAt"]).astimezone().isoformat()
        if info.get("isUsingOverage"):
            r["overage"] = True
            if not allow_extra_usage:
                return "quota", "extra_usage"
    elif ev.get("type") == "result":
        r.update(output={"result": (ev.get("result") or "")[:RESULT_MAX], "structured_output": ev.get("structured_output"),
                         "is_error": bool(ev.get("is_error")), "subtype": ev.get("subtype")},
                 usage=ev.get("usage"), num_turns=ev.get("num_turns"), cost_usd=ev.get("total_cost_usd"),
                 permission_denials=ev.get("permission_denials"))
    return None


def _resets(text: str) -> str | None:
    """Best effort: '3pm', '3pm (Europe/Paris)', 'Oct 25, 3pm' -> ISO time of the next such moment, else None."""
    from zoneinfo import ZoneInfo

    from dateutil import parser

    zone = re.search(r"\(([\w/+-]+)\)", text)
    try:
        tz = ZoneInfo(zone.group(1)) if zone else datetime.now().astimezone().tzinfo
        now = datetime.now(tz)
        t = parser.parse(re.sub(r"\(.*?\)", "", text), default=now.replace(minute=0, second=0, microsecond=0), fuzzy=True)
    except (ValueError, OverflowError, KeyError):  # ZoneInfoNotFoundError is a KeyError
        return None
    t = t if t.tzinfo else t.replace(tzinfo=tz)
    return (t + timedelta(days=1) if t <= now else t).isoformat()


async def _tail(stream: asyncio.StreamReader) -> str:
    buf = b""
    while chunk := await stream.read(65536):
        buf = (buf + chunk)[-TAIL:]
    return buf.decode(errors="replace")


async def stop(pgid: int) -> None:
    """SIGINT -> 10 s -> SIGTERM -> 5 s -> SIGKILL to the process group; returns once the group is empty."""
    for sig, grace_s in ((signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(pgid, sig)
            for _ in range(grace_s * 10):
                await asyncio.sleep(0.1)
                os.killpg(pgid, 0)
        except ProcessLookupError:
            return


async def run_agent(argv: list[str], prompt: str, cwd: str, log_path: str, timeout_s: float = 1800,
                    env: dict | None = None, allow_extra_usage: bool = False, container: str | None = None) -> dict:
    """Run one agent node, appending its stream-json lines to log_path as they come; with `container` (a name), in
    that container (in_container). Returns wf_steps fields:
    {status: done|failed|timeout|quota, error, output {result, structured_output, is_error, subtype}, exit_code,
    session_id, num_turns, usage, cost_usd, permission_denials, overage, resets_at}."""
    r = dict.fromkeys(("status", "error", "output", "exit_code", "session_id", "num_turns", "usage", "cost_usd",
                       "permission_denials", "resets_at"))
    r["overage"] = False
    env = env or child_env()
    if container:
        argv = in_container(argv, container, cwd, env.get("CTC_RUN"))
    p = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env, stdin=PIPE, stdout=PIPE,
                                             stderr=PIPE, start_new_session=True, limit=2**26)
    err = asyncio.create_task(_tail(p.stderr))
    try:
        async with asyncio.timeout(timeout_s):
            try:
                p.stdin.write(prompt.encode())
                await p.stdin.drain()
                p.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass  # it exited before reading; its exit code and stderr say why
            with open(log_path, "ab", buffering=0) as log:  # noqa: ASYNC230 - a local append per line, unbuffered for the live log view
                async for line in p.stdout:
                    log.write(line)
                    if why := _event(line, r, allow_extra_usage):
                        r["status"], r["error"] = why
                        break
            if not r["status"]:
                await p.wait()
    except TimeoutError:
        r["status"], r["error"] = "timeout", f"no result within {timeout_s} s"
    finally:
        if container:  # stopping the docker CLI below would leave its container running; gone already = a no-op
            with contextlib.suppress(OSError, TimeoutError):
                await _stdout("docker", "kill", container)
        await stop(p.pid)  # an early stop, a timeout, a cancel, or whatever a clean exit left running
    r["exit_code"] = await p.wait()
    stderr = await err
    if r["status"] is None:
        out = r["output"] or {}
        if out and not out["is_error"] and r["exit_code"] == 0:
            r["status"] = "done"
        else:  # a normal answer can quote the quota text, so only a failed node is checked for it
            text = f"{out.get('result') or ''}\n{stderr}".strip()
            m = QUOTA.search(text)
            r["status"] = "quota" if m or r["resets_at"] else "failed"
            r["resets_at"] = r["resets_at"] or (_resets(m.group(2)) if m else None)
            r["error"] = (f"{out['subtype']}: " if out else "") + (text[-TAIL:] or f"exit {r['exit_code']}")
    return r


async def run_shell(cmd: str, cwd: str, timeout: float, env: dict | None = None) -> dict:
    """`bash -c cmd` in its own process group; a non-zero exit is data. Returns {status: done|timeout, error,
    output {exit_code, stdout_tail, stderr_tail, duration_ms}}.
    ponytail: a grandchild that leaves the group (setsid) keeps the pipes open and holds this until it exits;
    the startup sweep (CTC_RUN) is the backstop."""
    t0 = time.monotonic()
    p = await asyncio.create_subprocess_exec("bash", "-c", cmd, cwd=cwd, env=env or child_env(), stdin=DEVNULL,
                                             stdout=PIPE, stderr=PIPE, start_new_session=True)
    tails = asyncio.gather(_tail(p.stdout), _tail(p.stderr))
    timed_out = False
    try:
        await asyncio.wait_for(p.wait(), timeout)
    except TimeoutError:
        timed_out = True
    finally:
        await stop(p.pid)  # the timeout, a cancel, or anything it left running in the background
    out, err = await tails
    return {"status": "timeout" if timed_out else "done", "error": f"timed out after {timeout} s" if timed_out else None,
            "output": {"exit_code": await p.wait(), "stdout_tail": out, "stderr_tail": err,
                       "duration_ms": round((time.monotonic() - t0) * 1000)}}


if __name__ == "__main__":
    import argparse
    import sys
    import tempfile
    import uuid

    ap = argparse.ArgumentParser(prog="python -m ctc.runner.proc")
    ap.add_argument("kind", choices=["agent", "shell"])
    ap.add_argument("text", help="agent prompt or shell command")
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("--model")
    ap.add_argument("--readonly", action="store_true")
    ap.add_argument("--resume", help="session id to fork")
    ap.add_argument("--container", action="store_true", help="run the agent in the ctc-runner image (container mode)")
    a = ap.parse_args()
    RUNS = Path((tmp := tempfile.TemporaryDirectory()).name)  # container homes of the self-check and of a --container run
    c = in_container(agent_argv({"prompt": "hi"}, {}, "s")[0], "ctc-run-1-a-1", "/wt", "1")  # self-check: container argv
    assert "--dangerously-skip-permissions" in c and "--permission-mode" not in c and "/wt:/wt" in c, c
    assert c[c.index("claude") + 1] == "-p" and c[c.index("--name") + 1] == "ctc-run-1-a-1" and "CTC_RUN=1" in c, c
    assert "/wt/.git:/wt/.git:ro" in c and f"{RUNS}/1/claude:/home/claude" in c and not any(  # never the host's ~/.claude
        x.endswith((".claude", ".claude.json")) for x in c[c.index("-v"):]), c
    assert "projects" not in json.loads((RUNS / "1" / "claude" / ".claude.json").read_text()), "host projects copied"
    c = in_container(agent_argv({"prompt": "hi", "readonly": True}, {}, "s")[0], "x", "/wt", None)
    assert c[c.index("--permission-mode") + 1] == "dontAsk" and "--dangerously-skip-permissions" not in c, c
    assert c[c.index("--append-system-prompt") + 1] == UNATTENDED, "every node, host or container, is told it runs unattended"

    async def main() -> int:
        if a.kind == "shell":
            r = await run_shell(a.text, os.getcwd(), a.timeout)
            o = r["output"]
            print("timeout" if r["status"] == "timeout" else f"exit={o['exit_code']}", f"duration_ms={o['duration_ms']}")
            print(o["stdout_tail"], end="")
            return 0
        pre = await preflight(a.container)
        if not pre["ok"]:
            print(f"authMethod={pre['authMethod']} preflight error: {pre['error']}")
            return 1
        node = {"prompt": a.text, "model": a.model, "readonly": a.readonly}
        argv, prompt = agent_argv(node, {}, str(uuid.uuid4()), resume=a.resume)
        fd, log = tempfile.mkstemp(prefix="ctc-agent-", suffix=".jsonl")
        os.close(fd)
        r = await run_agent(argv, prompt, os.getcwd(), log, a.timeout,
                            container=f"ctc-run-cli-{uuid.uuid4().hex[:8]}" if a.container else None)
        if r["status"] == "done":
            print(f"authMethod={pre['authMethod']} result={r['output']['result']} session_id={r['session_id']} "
                  f"turns={r['num_turns']} exit={r['exit_code']}")
        else:
            print(f"status={r['status']} resets_at={r['resets_at']} exit={r['exit_code']} error={(r['error'] or '')[:300]!r}")
        print(f"log={log} denials={json.dumps(r['permission_denials'])} overage={r['overage']}")
        return 0

    sys.exit(asyncio.run(main()))
