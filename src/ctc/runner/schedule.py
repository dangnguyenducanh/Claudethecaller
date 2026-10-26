"""Workflow schedules (PLAN.md m5 WB12): a cron on the canvas that the runner's 30 s loop fires, waiting while you work.

A schedule (wf_schedules: one per owner + workflow, cron in daemon local time) fires its latest due slot as a run with
trigger `schedule` once nothing holds it: a queued/running/waiting run of that workflow, an open usage window of this
owner, or a non-runner Claude session active in the last runner.idle_wait_min minutes (decision 8; env
CTC_IDLE_WAIT_MIN overrides, 0 = off). A held slot fires when the hold ends, and several held slots fire once. A slot
that passed while no daemon ran (over 2 min before this one started) is skipped. Either way last_fired_at becomes that
slot, the latest one handled, so nothing at or before it fires again. A scheduled run walks the project's workflow file
as committed at HEAD (half-edited files never run unattended) and records that version's sha256 as file_sha.
`python -m ctc.runner.schedule` runs the self-check.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml
from croniter import croniter

from ctc.runner.graph import load

log = logging.getLogger(__name__)
MISSED = timedelta(minutes=2)  # a slot this long before the daemon started passed while no daemon ran: skipped
STARTED = datetime.now(UTC)
PROJECTS = Path("~/.claude/projects").expanduser()  # the login's transcripts (runner children use the real HOME too)
# (owner, workflow) -> when PUT /schedule last saved it: slots before a save never fire.
# ponytail: per process; a second daemon of one login can fire a slot from before a save (one daemon per login, m5 Team)
ARMED: dict[tuple[str, str], datetime] = {}
ACTIVE_SQL = "select 1 from wf_runs where owner = %s and workflow = %s and status in ('queued', 'running', 'waiting') limit 1"
# compare-and-set: of two claimers (daemons of one login) only one moves last_fired_at, and only that one fires
FIRE_SQL = """update wf_schedules set last_fired_at = %s where owner = %s and workflow = %s and enabled
  and last_fired_at is not distinct from %s returning 1"""


def valid(cron: str) -> bool:
    """Five fields (min hour dom mon dow): croniter alone also takes a seconds field."""
    return len(cron.split()) == 5 and croniter.is_valid(cron)


def next_at(cron: str, base: datetime) -> datetime:
    """The first slot after base, in daemon local time."""
    return croniter(cron, base.astimezone()).get_next(datetime)


def due(cron: str, base: datetime, now: datetime, started: datetime = STARTED) -> tuple[str | None, datetime]:
    """(None, the next slot) when no slot passed since base; else ('fire' | 'skip', the latest slot <= now), 'skip'
    when even that one passed while no daemon ran."""
    nxt = next_at(cron, base)
    if nxt > now:
        return None, nxt
    last = max(nxt, croniter(cron, now.astimezone()).get_prev(datetime))  # get_prev is strictly before now
    return ("skip" if last < started - MISSED else "fire"), last


def busy(minutes: float, now: float, root: Path = PROJECTS) -> bool:
    """A non-runner Claude session wrote its transcript (root/*/*.jsonl) in the last `minutes`. Runner sessions' dirs
    (named after ~/.claudethecaller/runs/<id>/wt) don't count. 0 minutes = never busy."""
    if minutes <= 0:
        return False
    newest = max((p.stat().st_mtime for p in root.glob("*/*.jsonl") if "claudethecaller-runs" not in p.parent.name),
                 default=0.0)
    return now - newest < minutes * 60


def _base(r: dict, o: str) -> datetime:
    """Slots after this are due: the later of the last slot handled and the last save here; else this daemon's start."""
    return max([t for t in (r["last_fired_at"], ARMED.get((o, r["workflow"]))) if t] or [STARTED])


async def committed(repo: str, path: str) -> tuple[dict, str] | None:
    """(graph, sha256 of its bytes) of the workflow file at path as committed at repo's HEAD; None when it has no
    committed version (never committed, no commit yet, not a repo)."""
    from ctc.runner.engine import git  # engine imports this module

    rel = Path(path).resolve().relative_to(Path(repo).resolve()).as_posix()
    try:
        text = await git(repo, "show", f"HEAD:./{rel}")  # ./ = relative to repo, which can sit below the git top level
    except RuntimeError:
        return None
    return load(next(yaml.safe_load_all(text), None) or {}), hashlib.sha256(text.encode()).hexdigest()


def view(r: dict | None, o: str) -> dict | None:
    """A wf_schedules row as the API's schedule: next_at is the next slot (in the past while one is held), null when off."""
    if not r:
        return None
    return {k: r[k] for k in ("cron", "input", "enabled", "last_fired_at")} | {
        "next_at": next_at(r["cron"], _base(r, o)) if r["enabled"] else None}


async def tick(st, o: str | None) -> float:
    """The runner loop's schedule pass: fire this owner's due enabled schedules. Returns the seconds until the next
    slot (at most 30), so the loop wakes just after it. Never raises: the loop's claim comes after it."""
    # imported here: server.runs imports the engine, which imports this module
    from ctc.server.runs import submit_run

    wait = 30.0
    if not o:
        return wait
    try:
        now = datetime.now(UTC)
        quota = await st.store.fetchval("select 1 from wf_runs where owner = %s and quota_resets_at > now() limit 1", (o,))
        for r in await st.store.fetch("select * from wf_schedules where owner = %s and enabled", (o,)):
            w = r["workflow"]
            kind, slot = due(r["cron"], _base(r, o), now)
            if not kind:
                wait = min(wait, (slot - now).total_seconds() + 1)
                continue
            if kind == "fire" and (quota or busy(float(os.environ.get("CTC_IDLE_WAIT_MIN") or st.cfg["runner"]["idle_wait_min"]),
                                                 time.time()) or await st.store.fetchval(ACTIVE_SQL, (o, w))):
                continue  # held: looked at again next pass
            if not await st.store.fetchval(FIRE_SQL, (slot, o, w, r["last_fired_at"])):
                continue  # another daemon of this login took it, or the schedule was turned off meanwhile
            if kind == "skip":
                log.info("schedule %s: skipped %s, it passed while no daemon ran", w, slot)
                continue
            try:  # the slot is spent either way: a run that can't start is not retried every pass
                rid = await submit_run(st, "local", o, w, r["input"], None, "schedule", head=True)
                log.info("schedule %s: fired %s as run %s", w, slot, rid)
            except Exception as e:  # noqa: BLE001 - HTTPException (file gone, not committed, invalid graph) or the DB
                log.warning("schedule %s: slot %s not run: %s", w, slot, getattr(e, "detail", e))
    except Exception:
        log.exception("runner: schedule pass failed")
    return wait


if __name__ == "__main__":
    import tempfile

    t = datetime(2026, 10, 22, 12, 0, 30).astimezone()
    m = timedelta(minutes=1)
    # due: nothing since base; the latest of several slots fires once; a slot at exactly now is due
    assert due("* * * * *", t, t + 20 * timedelta(seconds=1), t - m) == (None, t.replace(second=0) + m)
    assert due("* * * * *", t, t + 3 * m, t - m) == ("fire", t.replace(second=0) + 3 * m)
    assert due("0 * * * *", t, t + 3 * m, t - m)[0] is None
    assert due("*/5 * * * *", t.replace(second=0), t.replace(second=0) + 5 * m, t - m) == ("fire", t.replace(second=0) + 5 * m)
    # missed: slots that all passed over 2 min before the daemon started are skipped (the latest one set); a held
    # slot after the start still fires however late
    assert due("0 9 * * *", t - timedelta(days=2), t, t) == ("skip", t.replace(hour=9, minute=0, second=0))
    assert due("* * * * *", t - 10 * m, t, t - 1 * m)[0] == "fire"
    assert due("* * * * *", t - 10 * m, t, t + 3 * m)[0] == "skip"
    assert due("* * * * *", t - 3 * m, t + 60 * m, t - 3 * m) == ("fire", t.replace(second=0) + 60 * m)
    # base: last slot handled vs the last save here vs this daemon's start
    ARMED[("o", "w")] = t
    assert _base({"workflow": "w", "last_fired_at": t - m}, "o") == t
    assert _base({"workflow": "w", "last_fired_at": t + m}, "o") == t + m
    assert _base({"workflow": "x", "last_fired_at": None}, "o") == STARTED
    assert view({"workflow": "w", "cron": "0 9 * * *", "input": "", "enabled": True, "last_fired_at": None}, "o")["next_at"] \
        == (t + timedelta(days=1)).replace(hour=9, minute=0, second=0)
    assert view({"workflow": "w", "cron": "0 9 * * *", "input": "", "enabled": False, "last_fired_at": None}, "o")["next_at"] is None
    assert valid("*/5 9-17 * * 1-5") and not valid("* * * *") and not valid("* * * * * *") and not valid("bad")
    # idle: the newest non-runner transcript decides; runner sessions' dirs are ignored; 0 = off
    with tempfile.TemporaryDirectory() as d:
        root, now = Path(d), time.time()
        for name, age in (("-home-me-repo", 3600), ("-home-me--claudethecaller-runs-12-wt", 10)):
            (root / name).mkdir()
            (root / name / "s.jsonl").touch()
            os.utime(root / name / "s.jsonl", (now - age, now - age))
        assert not busy(15, now, root) and busy(61, now, root) and not busy(0, now, root)
        assert not busy(15, now, root / "missing")
    print("schedule self-check ok")
