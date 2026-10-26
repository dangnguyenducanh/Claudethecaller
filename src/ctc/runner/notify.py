"""Run-event notify hook (spec FR-020): one shell command per run status change to failed, waiting, quota or done.

The command is the daemon-wide `runner.notify` in config/server.yaml, overridden per workflow by `settings.notify`
(present, even empty, wins; empty = off). It runs detached with env CTC_RUN_ID CTC_RUN_STATUS CTC_RUN_WORKFLOW
CTC_RUN_URL CTC_RUN_ERROR and a 10 s timeout; its output is appended to <runs dir>/<run id>/notify.log. A failing or
hanging command never changes the run. Examples:
  notify-send "ctc run $CTC_RUN_ID $CTC_RUN_STATUS" "$CTC_RUN_WORKFLOW"
  curl -s -m 5 -H 'content-type: application/json' -d "{\"text\": \"$CTC_RUN_WORKFLOW $CTC_RUN_STATUS $CTC_RUN_URL\"}" "$CHAT_WEBHOOK_URL"
Only the engine's committed transitions call fire(); cancel, reject and a re-queue to `queued` are not events.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

from ctc.config import cfg
from ctc.runner.proc import RUNS, child_env  # tests patch notify.RUNS

log = logging.getLogger(__name__)
TIMEOUT_S = 10
EVENTS = ("failed", "waiting", "quota", "done")


def fire(run: dict, status: str, error: str | None) -> threading.Thread | None:
    """Start the notify command for run (a wf_runs row: id, workflow, graph) entering status; None when status is not
    an event or no command is set. A plain thread, not an asyncio task: event-loop teardown cannot cancel it."""
    settings = run["graph"].get("settings") or {}
    cmd = settings["notify"] if "notify" in settings else cfg()["runner"].get("notify")
    if status not in EVENTS or not isinstance(cmd, str) or not cmd.strip():
        return None
    # never CTC_RUN: kill_run() and the sweep stop every process holding it
    env = {k: v for k, v in child_env().items() if k != "CTC_RUN"} | {
        "CTC_RUN_ID": str(run["id"]), "CTC_RUN_STATUS": status, "CTC_RUN_WORKFLOW": run["workflow"],
        "CTC_RUN_URL": f"http://127.0.0.1:{cfg()['port']}/#run/{run['id']}",  # the dashboard's run page
        "CTC_RUN_ERROR": (error or "")[:4096]}
    t = threading.Thread(target=_run, args=(cmd, env, RUNS / str(run["id"])), daemon=True)
    t.start()
    return t


# The timeout lives in a watchdog process of its own (python, not coreutils `timeout`: missing on macOS), so a hanging
# command is killed at TIMEOUT_S even when the daemon (and the thread waiting on it) exits first.
WATCHDOG = """import os, signal, subprocess, sys
p = subprocess.Popen(["bash", "-c", sys.argv[2]], stdin=subprocess.DEVNULL, start_new_session=True)
try:
    sys.exit(p.wait(float(sys.argv[1])))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    print(f"timeout after {sys.argv[1]} s", flush=True)
    sys.exit(124)
"""


def _run(cmd: str, env: dict, d: Path) -> None:
    try:
        d.mkdir(parents=True, exist_ok=True)
        with (d / "notify.log").open("a") as f:
            f.write(f"--- {datetime.now(UTC).isoformat()} {env['CTC_RUN_STATUS']}\n")
            f.flush()
            p = subprocess.Popen([sys.executable, "-c", WATCHDOG, str(TIMEOUT_S), cmd], cwd=d, env=env,
                                 stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
            f.write(f"exit {p.wait()}\n")  # bounded: the watchdog exits by TIMEOUT_S
    except OSError as e:
        log.warning("notify for run %s failed: %s", env["CTC_RUN_ID"], e)
