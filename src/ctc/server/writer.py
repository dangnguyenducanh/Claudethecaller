"""Stream writer (PLAN.md B5, Cache design): hooks enqueue rows on `ctc:writes`, one task per daemon batches them into
Postgres; Redis down → the row goes straight to the DB."""

from __future__ import annotations

import asyncio
import itertools
import logging
import os
import socket

import orjson
import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

# Applied in this order within a batch so FKs resolve (a decision's session row first).
SQL = {
    "session": "insert into sessions (id, user_id, project_id, title, turns)"
               " values (%(id)s, %(user_id)s, %(project_id)s, %(title)s, %(turns)s)"
               " on conflict (id) do update set turns = sessions.turns + excluded.turns,"
               " title = case when sessions.title = '' then excluded.title else sessions.title end",
    # the session row may still sit in the stream (or a dropped batch) when a decision arrives on the direct path
    "decision": "with s as (insert into sessions (id, user_id, project_id) values (%(session_id)s, %(user_id)s, %(project_id)s)"
                " on conflict (id) do nothing) insert into decisions (user_id, session_id, project_id, ref, prompt, abstained, confidence, difficulty,"
                " model_tier, latency_ms, bundle, stages, graph_line) values (%(user_id)s, %(session_id)s, %(project_id)s, %(ref)s,"
                " %(prompt)s, %(abstained)s, %(confidence)s, %(difficulty)s, %(model_tier)s, %(latency_ms)s, %(bundle)s,"
                " %(stages)s, %(graph_line)s) on conflict (session_id, ref) do nothing",
    "event": "insert into events (session_id, type, payload) values (%(session_id)s, %(type)s, %(payload)s)",
    "followed": "update decisions set followed = true where session_id = %(session_id)s and ref = %(ref)s",
    "session_end": "update sessions set ended_at = now(), model = %(model)s, tokens = %(tokens)s where id = %(id)s",
}
DEFAULTS = {
    "session": {"user_id": "local", "title": "", "turns": 1},
    "decision": {"user_id": "local", "confidence": 0.0, "difficulty": "standard", "model_tier": "sonnet", "latency_ms": 0.0, "stages": [],
                 "graph_line": None},
    "event": {"payload": {}},
    "session_end": {"model": "", "tokens": 0},
}
JSON = {"decision": ("bundle", "stages"), "event": ("payload",)}


def _params(kind: str, row: dict) -> dict:
    p = {**DEFAULTS.get(kind, {}), **row}
    for f in JSON.get(kind, ()):
        p[f] = Jsonb(p[f])
    return p


async def _apply(st, batch: list[tuple[str, dict]]) -> None:
    """One transaction, one executemany per kind: a retried batch never doubles the session turn counters."""
    async def go(conn):
        async with conn.transaction():
            for kind, group in itertools.groupby(batch, key=lambda item: item[0]):
                async with conn.cursor() as cur:
                    await cur.executemany(SQL[kind], [_params(kind, r) for _, r in group])
    await st.store._run(go)


async def apply(st, items: list[tuple[str, dict]]) -> None:
    """Raises only psycopg.OperationalError (DB unreachable/timeout: retry the batch later). A row that can never apply
    (FK to a missing project, bad field) is logged and dropped, so one poison entry cannot wedge the stream."""
    if unknown := {k for k, _ in items if k not in SQL}:
        log.warning("writer: dropped rows of unknown kind %s", sorted(unknown))
    batch = [(k, r) for k in SQL for kind, r in items if kind == k]
    try:
        await _apply(st, batch)
    except psycopg.OperationalError:
        raise
    except Exception:
        log.exception("writer: batch of %d rows failed, applying row by row", len(batch))
        for item in batch:
            try:
                await _apply(st, [item])
            except psycopg.OperationalError:
                raise
            except Exception:
                log.exception("writer: dropped %s row %s", item[0], str(item[1])[:200])


async def write(st, kind: str, row: dict) -> None:
    """Queue one row; Redis down → apply it now. Never raises (hook path); a DB error then loses the row."""
    try:
        if await st.cache.enqueue(kind, row):
            return
        # same JSON round trip as the stream: numpy scalars, datetimes become plain JSON values
        await apply(st, [(kind, orjson.loads(orjson.dumps(row, option=orjson.OPT_SERIALIZE_NUMPY)))])
    except Exception:
        log.exception("writer: direct %s write failed, row lost", kind)


async def run_writer(st) -> None:
    """Daemon task: read up to writer.batch entries (or interval_s) → apply → XACK. DB down → no ack: the entries stay
    pending and this consumer re-claims them after reclaim_idle_ms (XAUTOCLAIM in read_writes), with a growing back-off."""
    wc, consumer, backoff = st.cfg["writer"], f"{socket.gethostname()}:{os.getpid()}", 1.0
    while True:
        got = await st.cache.read_writes(consumer, wc["batch"], int(wc["interval_s"] * 1000))
        if not got:
            continue
        try:
            await apply(st, [(kind, row) for _, kind, row in got])
        except psycopg.OperationalError as e:
            log.warning("writer: %d rows not applied, retry in %.0fs: %s: %s", len(got), backoff, type(e).__name__, e)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
            continue
        backoff = 1.0
        if not await st.cache.ack_writes([i for i, _, _ in got]):
            # ponytail: no ack retry; the entries are re-claimed and applied again (idempotent except turns/events)
            log.warning("writer: XACK of %d entries failed", len(got))
