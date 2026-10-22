"""Background jobs (PLAN.md AI integration flow): a `jobs` row is the truth, its id goes on the Redis stream `ctc:jobs`;
one worker task per daemon runs one job at a time (llama-server has one slot). Redis down → the worker polls the table."""

from __future__ import annotations

import asyncio
import importlib
import logging
import os
import socket
import time
import uuid

import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

# "module:function", imported at dispatch so a broken optional module (ai/*) never breaks daemon startup
HANDLERS = {
    "index": "ctc.ingestion.indexer:run_job",
    "enrich": "ctc.ai.enrich:run_job",
    "extract": "ctc.ai.extract:run_job",
    "backfill": "ctc.ai.extract:run_backfill",
    "import_memory": "ctc.memory.longterm:run_import",
    "history": "ctc.ingestion.history:run_job",
    "distill": "ctc.ingestion.history:run_distill",
}
# ponytail: no timeout for these: a first import or a long session's distill (LLM chunks + replay) passes 60 s; a hung
# LLM call holds the worker until the openai client's own 600 s timeout. Per-kind timeouts if that bites.
UNTIMED = {"index", "history", "distill"}
COLS = "id::text as id, kind, status, progress, result, error, created_at"


def _handler(kind: str):
    mod, fn = HANDLERS[kind].split(":")
    return getattr(importlib.import_module(mod), fn)


async def submit(st, kind: str, payload: dict, user_id: str = "local") -> str:
    job_id = await st.store.fetchval(
        "insert into jobs (user_id, kind, payload) values (%s, %s, %s) returning id::text", (user_id, kind, Jsonb(payload)))
    await st.cache.enqueue_job(job_id)  # False when Redis is down: the worker's table poll finds it
    return job_id


async def get_job(st, job_id: str, user_id: str = "local") -> dict | None:
    try:
        uuid.UUID(job_id)
    except ValueError:
        return None
    return await st.store.fetchrow(f"select {COLS} from jobs where id = %s and user_id = %s", (job_id, user_id))


async def list_jobs(st, status: str | None = None, kind: str | None = None, limit: int = 50, user_id: str = "local") -> list[dict]:
    return await st.store.fetch(
        f"select {COLS} from jobs where user_id = %(u)s and (%(s)s::text is null or status = %(s)s)"
        " and (%(k)s::text is null or kind = %(k)s) order by created_at desc limit %(n)s",
        {"u": user_id, "s": status, "k": kind, "n": limit})


async def _run(st, job_id: str) -> None:
    """1 + jobs.retries attempts (timeout jobs.timeout_s, UNTIMED exempt), fewer if `attempts` reaches dead_after;
    then failed with the last error."""
    jc = st.cfg["jobs"]
    job = await st.store.fetchrow(  # atomic claim: N daemons never run one job twice
        "update jobs set status = 'running', updated_at = now() where id = %s and status = 'queued' returning kind, payload",
        (job_id,))
    if not job:  # another worker has it, or the table poll ran it before its stream entry arrived
        return
    last = 0.0

    async def progress(fraction: float) -> None:
        nonlocal last
        if time.monotonic() - last < 1.0:
            return
        last = time.monotonic()
        try:
            await st.store.execute("update jobs set progress = %s, updated_at = now() where id = %s", (fraction, job_id))
        except Exception:  # a lost progress tick must not fail the job
            log.exception("job %s: progress update failed", job_id)

    err = ""
    for _ in range(1 + jc["retries"]):
        n = await st.store.fetchval("update jobs set attempts = attempts + 1, updated_at = now() where id = %s returning attempts", (job_id,))
        try:
            run = _handler(job["kind"])(st, job["payload"], progress)
            result = await (run if job["kind"] in UNTIMED else asyncio.wait_for(run, jc["timeout_s"]))
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            log.exception("job %s (%s) attempt %d failed", job_id, job["kind"], n)
            if n >= jc["dead_after"]:
                break
            continue
        await st.store.execute("update jobs set status = 'done', progress = 1, result = %s, error = null, updated_at = now() where id = %s",
                               (Jsonb(result), job_id))
        return
    await st.store.execute("update jobs set status = 'failed', error = %s, updated_at = now() where id = %s", (err, job_id))


async def run_worker(st) -> None:
    """Daemon task. On start, `running` rows a dead worker left are re-queued (failed once they used dead_after
    attempts): every one in local mode (one daemon), those idle > 10 × timeout_s in shared mode.
    ponytail: the sweep runs at start only; a row left `running` by a DB blip mid-job waits for the next daemon start."""
    jc, consumer = st.cfg["jobs"], f"{socket.gethostname()}:{os.getpid()}"
    stale = 0.0 if st.cfg["mode"] == "local" else 10.0 * jc["timeout_s"]
    while True:
        try:
            await st.store.execute(
                "update jobs set status = case when attempts >= %(d)s then 'failed' else 'queued' end,"
                " error = case when attempts >= %(d)s then 'worker stopped mid-run' else error end, updated_at = now()"
                " where status = 'running' and updated_at < now() - make_interval(secs => %(s)s)", {"d": jc["dead_after"], "s": stale})
            break
        except psycopg.Error as e:
            log.warning("jobs: stale sweep failed, retry in 5s: %s", e)
            await asyncio.sleep(5)
    while True:
        try:
            if got := await st.cache.read_jobs(consumer, 1000):
                await _run(st, got[0][1])
                await st.cache.ack_job(got[0][0])
            # ponytail: one cheap query per idle second; catches jobs queued while Redis was down and re-queued rows
            elif job_id := await st.store.fetchval("select id::text from jobs where status = 'queued' order by created_at limit 1"):
                await _run(st, job_id)
        except Exception:  # DB down: the job row / stream entry stays; try again shortly
            log.exception("jobs: worker loop error")
            await asyncio.sleep(2)
