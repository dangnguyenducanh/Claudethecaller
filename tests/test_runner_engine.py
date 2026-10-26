"""The engine test seam (spec "Testing Decisions", Q18): a workflow YAML goes in, run and step rows come out.

Fixtures (tests/conftest.py):
- `run_yaml(yaml_text, input="", claude_script=None) -> (run, steps)` submits the workflow, claims it and walks it to
  its end in this process. `claude_script`: None = the fake's default result, a dict = result fields replayed for every
  agent call, a list of dicts = one per agent call in order, a str = another fake binary (e.g. scripts/fake_claude_quota.sh).
- `walk_run(rid)` claims and walks an existing run (after approve()/resume()); `in_store(fn)` awaits fn(st) on a Store.
DB cases skip when CTC_DATABASE_URL is unset or contains `supabase`. Each test session gets a throwaway schema on the
scratch Postgres, and runs/worktrees go to a tmp dir, never ~/.claudethecaller.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_runner_engine.py`.
"""

import asyncio
from pathlib import Path

import pytest
from conftest import FAKE

from ctc.config import cfg
from ctc.runner import proc

SHELL_IF = """
name: seam-if
nodes:
- {id: start, type: trigger}
- {id: write, type: shell, command: "printf 'hi\\\\n' > hello.txt; exit {{input}}"}
- {id: ok, type: if, path: write.exit_code, op: eq, value: 0}
- {id: 'yes', type: shell, command: echo yes}
- {id: 'no', type: shell, command: echo no}
edges:
- {from: start, to: write}
- {from: write, to: ok}
- {from: ok, to: 'yes', handle: 'true'}
- {from: ok, to: 'no', handle: 'false'}
"""
AGENT = """
name: seam-agent
nodes:
- {id: start, type: trigger}
- {id: ask, type: agent, prompt: "Say {{input}}"}
- {id: echo, type: shell, command: "echo {{ask.result}}"}
edges:
- {from: start, to: ask}
- {from: ask, to: echo}
"""


def by_node(steps: list[dict]) -> dict[str, dict]:
    return {s["node_id"]: s for s in steps}


def test_fake_claude_passes_preflight(monkeypatch):
    monkeypatch.setenv("CTC_CLAUDE_BIN", str(FAKE))
    pre = asyncio.run(proc.preflight())
    assert pre["ok"] is True, pre
    assert pre["authMethod"] == "claude.ai"
    assert pre["email"] == "fake@example.com"
    assert pre["claude_version"] == cfg()["runner"]["claude_version"] == "2.1.306"


def test_a_cancelled_helper_command_is_reaped():
    """The max_run_minutes killer is cancelled when the batch lands: its `docker ps` (proc._stdout) must not be left
    running for a closed loop's transport to collect (the PytestUnraisableExceptionWarning)."""
    async def go():
        t = asyncio.create_task(proc._stdout("sleep", "7.3125"))
        await asyncio.sleep(0.3)
        t.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t
    asyncio.run(go())
    alive = [p for p in Path("/proc").glob("[0-9]*/cmdline") if _read(p) == b"sleep\x007.3125\x00"]
    assert alive == []


def _read(p: Path) -> bytes:
    try:
        return p.read_bytes()
    except OSError:
        return b""


@pytest.mark.parametrize(("text", "taken", "skipped"), [("0", "yes", "no"), ("1", "no", "yes")])
def test_shell_if_chain_runs_to_done(run_yaml, seam, text, taken, skipped):
    run, steps = run_yaml(SHELL_IF, input=text)
    assert (run["status"], run["error"]) == ("done", None)
    assert run["auth"]["authMethod"] == "claude.ai"
    assert run["branch"] == f"ctc/seam-if-{run['id']}"
    assert Path(run["worktree"]).is_relative_to(seam.runs)
    s = by_node(steps)
    assert (s["start"]["status"], s["start"]["output"]) == ("done", {"input": text})
    assert s["write"]["status"] == "done"
    assert s["write"]["output"]["exit_code"] == int(text)
    assert s["write"]["files"] == [{"path": "hello.txt", "added": 1, "deleted": 0}]
    assert (s["ok"]["status"], s["ok"]["output"]) == ("done", {"value": text == "0"})
    assert s[taken]["status"] == "done"
    assert (s[skipped]["status"], s[skipped]["kind"], s[skipped]["visit"]) == ("skipped", "shell", 1)


def test_agent_node_replays_scripted_result_and_tokens(run_yaml, seam):
    usage = {"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 1000}
    run, steps = run_yaml(AGENT, input="hello", claude_script={"result": "scripted answer", "num_turns": 2, "usage": usage})
    assert (run["status"], run["error"]) == ("done", None)
    assert run["tokens"] == 150  # cache reads are not counted
    s = by_node(steps)
    ask = s["ask"]
    assert (ask["status"], ask["input"], ask["output"]["result"]) == ("done", "Say hello", "scripted answer")
    assert (ask["num_turns"], ask["usage"]) == (2, usage)
    assert ask["session_id"]
    assert s["echo"]["output"]["stdout_tail"] == "scripted answer\n"
    log = Path(ask["log_path"] + ".gz")
    assert log.exists() and log.is_relative_to(seam.runs)


def test_script_list_gives_one_result_per_agent_call(run_yaml):
    two = AGENT.replace("- {from: ask, to: echo}", "- {from: ask, to: ask2}\n- {from: ask2, to: echo}").replace(
        "- {id: echo,", "- {id: ask2, type: agent, prompt: again}\n- {id: echo,")
    run, steps = run_yaml(two, claude_script=[{"result": "one"}, {"result": "two"}])
    s = by_node(steps)
    assert run["status"] == "done"
    assert (s["ask"]["output"]["result"], s["ask2"]["output"]["result"]) == ("one", "two")


def test_failed_agent_result_fails_run(run_yaml):
    run, steps = run_yaml(AGENT, input="hello",
                          claude_script={"is_error": True, "subtype": "error_during_execution", "result": "boom"})
    assert run["status"] == "failed"
    assert run["error"].startswith("ask: ") and "boom" in run["error"]
    s = by_node(steps)
    assert s["ask"]["status"] == "failed"
    assert "echo" not in s


def test_quota_fake_parks_run_as_quota(run_yaml):
    run, steps = run_yaml(AGENT, input="hello", claude_script="scripts/fake_claude_quota.sh")
    assert run["status"] == "quota"
    assert run["quota_resets_at"] is not None
    assert "session limit" in run["error"]
    s = by_node(steps)
    assert s["ask"]["status"] == "quota"
    assert "echo" not in s
