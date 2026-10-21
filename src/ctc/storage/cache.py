"""Cache: L1 in-process LRU -> L2 Redis (PLAN.md B4b, "Cache design").

Redis is never a source of truth and never raises: a connection error or timeout marks it down for cc["down_for_s"]
(logged once per window) and every call answers from L1 alone (None / False / 0 / [] where L1 has nothing). A command
error (NOGROUP, no such index after a FLUSHDB, a bad argument) only fails that call and re-creates the index and groups.
L1 entries live at most _L1_MAX_S, so a missed ctc:inval message heals within that.
# ponytail: crude breaker (any connection error = down for the whole window), a real one if flapping shows up.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import logging
import time
from collections import OrderedDict

import numpy as np
import orjson
import redis.asyncio as redis
from redis.exceptions import RedisError, ResponseError

from ctc.config import cfg

log = logging.getLogger(__name__)
_SEM_QUERY = "(@libv:{$v} @project:{$p} @user:{$u})=>[KNN 1 @vec $qv AS d]"
_NP = orjson.OPT_SERIALIZE_NUMPY
_ERRORS = (RedisError, OSError)  # OSError covers socket and timeout errors redis-py does not wrap
_L1_MAX_S = 60.0


def _tag(s: str) -> str:
    """TAG values are hex only: raw TAGs are case-insensitive and split on ',', which would mix users' entries."""
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def _f32(vec) -> bytes:
    return np.asarray(vec, dtype="float32").ravel().tobytes()


def _unit(vec) -> bytes:
    v = np.asarray(vec, dtype="float32").ravel()
    return (v / max(float(np.linalg.norm(v)), 1e-9)).astype("float32").tobytes()


def _vec(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw, dtype="float32").copy()  # copy: writable, callers may normalize in place


class Cache:
    WRITES, JOBS, INVAL = "ctc:writes", "ctc:jobs", "ctc:inval"

    def __init__(self, url: str, cc: dict):
        self.cc = cc
        self.r = redis.from_url(url, socket_timeout=cc["redis_timeout_s"], socket_connect_timeout=0.05, protocol=2)
        # Blocking stream reads + pub/sub need a read timeout longer than their block; never on the prompt path.
        # ponytail: fixed 10 s, so block_ms must stay under 10000.
        self.rb = redis.from_url(url, socket_timeout=10, socket_connect_timeout=0.05, protocol=2)
        self._l1: dict[str, OrderedDict] = {}  # key prefix (before the first ':') -> key -> (expires_at, raw bytes)
        self._down_until = 0.0
        self._quiet: dict[str, float] = {}  # log line -> silent until (one line of each kind per down_for_s window)
        self._ready: set[str] = set()  # FT index / stream groups known to exist since the last outage

    @property
    def up(self) -> bool:
        return time.monotonic() >= self._down_until

    def _warn(self, what: str, e: BaseException) -> None:
        now = time.monotonic()
        if now >= self._quiet.get(what, 0.0):
            self._quiet[what] = now + self.cc["down_for_s"]
            log.warning("%s: %s: %s", what, type(e).__name__, e)  # repr() of redis-py errors drops the message

    async def _safe(self, aw, default=None, ok: str = "", gate: bool = True):
        """Await one Redis call, never raising; returns `default` on error (an error containing `ok` is success).
        gate=False runs it even inside the down window (acks: a skipped XACK means the entry is applied twice)."""
        if gate and not self.up:
            aw.close()
            return default
        try:
            return await aw
        except ResponseError as e:  # the server answered: Redis is up, only this command failed
            if ok and ok in str(e):
                return True
            self._ready.clear()  # a FLUSHDB drops the index and the groups: re-create them on the next call
            self._warn("redis command failed", e)
        except _ERRORS as e:
            self._down_until = time.monotonic() + self.cc["down_for_s"]
            self._ready.clear()  # a restarted Redis has lost the index and the groups
            self._warn(f"redis down for {self.cc['down_for_s']}s", e)
        return default

    async def start(self) -> None:
        if await self._safe(self.r.ping()):
            await self._index()

    async def close(self) -> None:
        for c in (self.r, self.rb):
            with contextlib.suppress(Exception):
                await c.aclose()

    async def _index(self) -> bool:
        if "sem" not in self._ready and await self._safe(self.r.execute_command(
            "FT.CREATE", "ctc_sem", "ON", "HASH", "PREFIX", 1, "sem:", "SCHEMA", "libv", "TAG", "project", "TAG",
            "user", "TAG", "vec", "VECTOR", "FLAT", 6, "TYPE", "FLOAT32", "DIM", cfg()["embedding_dim"],
            "DISTANCE_METRIC", "COSINE"), ok="already exists"):
            self._ready.add("sem")
        return "sem" in self._ready

    # --- L1 + L2 key/value -------------------------------------------------------------------------------------------

    def _lru(self, key: str) -> OrderedDict:
        return self._l1.setdefault(key.split(":", 1)[0], OrderedDict())

    def _l1_put(self, key: str, raw: bytes, ttl: float | None) -> None:
        d = self._lru(key)
        d[key] = (time.monotonic() + (_L1_MAX_S if ttl is None else min(ttl, _L1_MAX_S)), raw)
        d.move_to_end(key)
        if len(d) > self.cc["l1_size"]:
            d.popitem(last=False)

    async def _get(self, key: str) -> bytes | None:
        d = self._lru(key)
        hit = d.get(key)
        if hit and hit[0] > time.monotonic():
            d.move_to_end(key)
            return hit[1]
        d.pop(key, None)
        got = await self._safe(self.r.pipeline(transaction=False).get(key).pttl(key).execute())
        if not got or got[0] is None:
            return None
        if got[1] > 0 or got[1] == -1:  # L1 never outlives the Redis TTL; 0 / -2: expiring right now, skip L1
            self._l1_put(key, got[0], got[1] / 1000 if got[1] > 0 else None)
        return got[0]

    async def _set(self, key: str, raw: bytes, ttl: int | None) -> None:
        self._l1_put(key, raw, ttl)
        await self._safe(self.r.set(key, raw, ex=ttl))

    async def get_json(self, key: str) -> object | None:
        raw = await self._get(key)
        return None if raw is None else orjson.loads(raw)

    async def set_json(self, key: str, value, ttl: int | None) -> None:
        await self._set(key, orjson.dumps(value, option=_NP), ttl)

    async def get_vec(self, key: str) -> np.ndarray | None:
        raw = await self._get(key)
        return None if raw is None else _vec(raw)

    async def set_vec(self, key: str, vec, ttl: int | None) -> None:
        await self._set(key, _f32(vec), ttl)

    async def delete(self, *keys: str) -> None:
        for k in keys:
            self._lru(k).pop(k, None)
        if keys:
            await self._safe(self.r.delete(*keys))

    def l1_drop(self, prefix: str) -> None:
        d = self._lru(prefix)
        for k in [k for k in d if k.startswith(prefix)]:
            del d[k]

    # --- semantic cache ----------------------------------------------------------------------------------------------

    async def semantic_get(self, qv, libv: str, project: str, user: str = "local") -> dict | None:
        if not await self._index():
            return None
        got = await self._safe(self.r.execute_command(
            "FT.SEARCH", "ctc_sem", _SEM_QUERY, "PARAMS", 8, "v", _tag(libv), "p", _tag(project), "u", _tag(user), "qv", _unit(qv),
            "RETURN", 2, "bundle", "d", "LIMIT", 0, 1, "DIALECT", 2))
        if not got or not got[0]:
            return None
        f = dict(zip(got[2][::2], got[2][1::2]))  # RESP2 (protocol=2 above): [total, key, [field, value, ...]]
        return orjson.loads(f[b"bundle"]) if 1 - float(f[b"d"]) >= self.cc["semantic_min_cos"] else None

    async def semantic_put(self, ref: str, qv, libv: str, project: str, bundle: dict, user: str = "local") -> None:
        key = f"sem:{ref}"
        tags = {"libv": _tag(libv), "project": _tag(project), "user": _tag(user)}
        row = {"vec": _unit(qv), **tags, "bundle": orjson.dumps(bundle, option=_NP)}
        await self._safe(self.r.pipeline(transaction=False).hset(key, mapping=row).expire(key, self.cc["ttl"]["sem"]).execute())

    # --- streams: ctc:writes (stream writer), ctc:jobs (job workers) -------------------------------------------------

    async def _read(self, stream: str, group: str, consumer: str, count: int, block_ms: int, idle_ms: int | None) -> list:
        """Entries idle > idle_ms (a crashed consumer's; no reclaim when None) first, then new ones.
        An empty read takes block_ms even when Redis is down, like a BLOCK that timed out, so reader loops never spin."""
        t, entries = time.monotonic(), []
        # id 0: entries enqueued before the first reader started are not skipped
        if stream not in self._ready and await self._safe(self.rb.xgroup_create(stream, group, id="0", mkstream=True), ok="BUSYGROUP"):
            self._ready.add(stream)
        if stream in self._ready and idle_ms is not None:
            entries = (await self._safe(self.rb.xautoclaim(stream, group, consumer, idle_ms, count=count), default=[0, []]))[1]
        if stream in self._ready and len(entries) < count:
            new = await self._safe(self.rb.xreadgroup(
                group, consumer, {stream: ">"}, count=count - len(entries), block=None if entries else (block_ms or None)
            ), default=[])
            entries += [e for _, es in new for e in es]
        out = [(i.decode(), f) for i, f in entries if f]
        if not out and block_ms:
            await asyncio.sleep(max(0.0, block_ms / 1000 - (time.monotonic() - t)))
        return out

    async def enqueue(self, kind: str, row: dict) -> bool:
        fields = {"kind": kind, "row": orjson.dumps(row, option=_NP)}
        return bool(await self._safe(self.r.xadd(self.WRITES, fields, maxlen=self.cc["stream_maxlen"], approximate=True)))

    async def read_writes(self, consumer: str, count: int, block_ms: int, idle_ms: int | None = None) -> list[tuple[str, str, dict]]:
        idle = cfg()["writer"]["reclaim_idle_ms"] if idle_ms is None else idle_ms
        got = await self._read(self.WRITES, "writers", consumer, count, block_ms, idle)
        return [(i, f[b"kind"].decode(), orjson.loads(f[b"row"])) for i, f in got]

    async def ack_writes(self, ids: list[str]) -> bool:
        """False when the XACK did not reach Redis (retry it, or the entries are reclaimed and applied again)."""
        return not ids or await self._safe(self.rb.xack(self.WRITES, "writers", *ids), gate=False) is not None

    async def enqueue_job(self, job_id: str) -> bool:
        return bool(await self._safe(self.r.xadd(self.JOBS, {"job": job_id}, maxlen=self.cc["stream_maxlen"], approximate=True)))

    async def read_jobs(self, consumer: str, block_ms: int) -> list[tuple[str, str]]:
        # No reclaim: index jobs have no timeout, so "idle" never means "dead"; the ctc.jobs row is the truth and the
        # job runner re-queues stale `running` rows itself.
        return [(i, f[b"job"].decode()) for i, f in await self._read(self.JOBS, "workers", consumer, 1, block_ms, None)]

    async def ack_job(self, entry_id: str) -> bool:
        return await self._safe(self.rb.xack(self.JOBS, "workers", entry_id), gate=False) is not None

    # --- invalidation pub/sub ----------------------------------------------------------------------------------------

    async def publish_inval(self, scope: str, **fields) -> None:
        await self._safe(self.r.publish(self.INVAL, orjson.dumps({"scope": scope, **fields})))

    def subscribe_inval(self, callback) -> asyncio.Task:
        """Task calling callback(dict) (sync or async) per ctc:inval message; resubscribes with backoff while down.
        Its own errors never open the breaker (the prompt path stays on L2).
        # ponytail: a half-open link (NAT idle timeout) goes unnoticed; the _L1_MAX_S cap bounds the staleness."""

        async def run() -> None:
            backoff = 0.1
            while True:
                if self.up:
                    ps = self.rb.pubsub()
                    try:
                        await ps.subscribe(self.INVAL)
                        self._l1.clear()  # messages were missed while unsubscribed
                        backoff = 0.1
                        while True:
                            msg = await ps.get_message(ignore_subscribe_messages=True, timeout=1.0)
                            if not msg:
                                continue
                            try:
                                out = callback(orjson.loads(msg["data"]))
                                if inspect.isawaitable(out):
                                    await out
                            except Exception:
                                log.exception("ctc:inval callback failed")
                    except _ERRORS as e:
                        self._warn("ctc:inval subscriber lost", e)
                    finally:
                        with contextlib.suppress(Exception):
                            await ps.aclose()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 1.0)

        return asyncio.create_task(run())

    # --- rate limit, session turns -----------------------------------------------------------------------------------

    async def hit_rate(self, user: str) -> int:
        key = f"rl:{user}:{int(time.time() // 60)}"
        got = await self._safe(self.r.pipeline(transaction=False).incr(key).expire(key, 60).execute())
        return got[0] if got else 0

    async def push_turn(self, session_id: str, vec, ttl: int, maxlen: int = 20) -> None:
        # ponytail: turns live in Redis only, so session blending drops out while Redis is down
        key = f"sess:{session_id}:turns"
        await self._safe(self.r.pipeline(transaction=False).rpush(key, _f32(vec)).ltrim(key, -maxlen, -1).expire(key, ttl).execute())

    async def get_turns(self, session_id: str) -> list[np.ndarray]:
        return [_vec(b) for b in await self._safe(self.r.lrange(f"sess:{session_id}:turns", 0, -1), default=[])]

    async def clear_turns(self, session_id: str) -> None:
        await self._safe(self.r.delete(f"sess:{session_id}:turns"))


async def _check() -> None:
    cc = cfg()["cache"]
    c = Cache(cfg()["redis_url"], cc)
    c.WRITES, c.JOBS, c.INVAL = "selfcheck:writes", "selfcheck:jobs", "selfcheck:inval"  # never the daemon's streams
    await c.start()
    assert c.up and "sem" in c._ready, "redis unreachable or FT.CREATE failed"
    try:
        # json: L1 hit, L2 hit after clearing L1 (refills L1), delete, TTL honored in L1
        await c.set_json("bundle:selfcheck", {"a": [1, 2]}, 60)
        assert await c.get_json("bundle:selfcheck") == {"a": [1, 2]}
        c._l1.clear()
        assert await c.get_json("bundle:selfcheck") == {"a": [1, 2]} and "bundle:selfcheck" in c._l1["bundle"]
        await c.delete("bundle:selfcheck")
        assert await c.get_json("bundle:selfcheck") is None
        await c.set_json("bundle:selfcheck", 1, 1)
        await asyncio.sleep(1.1)
        assert await c.get_json("bundle:selfcheck") is None
        c.l1_drop("bundle:self")
        assert "bundle:selfcheck" not in c._l1["bundle"]
        await c.set_json("lib:selfcheck", "v1", None)  # no TTL in Redis: L1 still re-reads it within _L1_MAX_S
        assert c._l1["lib"]["lib:selfcheck"][0] <= time.monotonic() + _L1_MAX_S
        # vectors
        rng = np.random.default_rng(0)
        a = rng.standard_normal(1024)
        a /= np.linalg.norm(a)
        await c.set_vec("emb:selfcheck", a, 60)
        c._l1.clear()
        assert np.allclose(await c.get_vec("emb:selfcheck"), a)
        # semantic: hit at cosine 0.99, miss for another libv and at cosine 0.5
        b = rng.standard_normal(1024)
        b -= (b @ a) * a
        b /= np.linalg.norm(b)

        def at(cos: float) -> np.ndarray:
            return cos * a + np.sqrt(1 - cos**2) * b

        await c.semantic_put("selfcheck", a, "selfcheck", "selfcheck", {"ref": "selfcheck"}, user="selfcheck")
        assert await c.semantic_get(at(0.99), "selfcheck", "selfcheck", "selfcheck") == {"ref": "selfcheck"}
        assert await c.semantic_get(at(0.99), "otherlibv", "selfcheck", "selfcheck") is None
        assert await c.semantic_get(at(0.5), "selfcheck", "selfcheck", "selfcheck") is None
        assert await c.semantic_get(at(0.99), "selfcheck", "selfcheck", "SelfCheck") is None  # hashed TAGs: exact user
        assert await c.semantic_get(np.ones(8), "selfcheck", "selfcheck", "selfcheck") is None and c.up  # command error
        # writes stream: read, reclaim an unacked entry from another consumer, ack
        assert await c.enqueue("event", {"n": 1})
        [(i1, kind, row)] = await c.read_writes("selfcheck-a", 10, 10)
        assert (kind, row) == ("event", {"n": 1})
        await asyncio.sleep(0.05)
        assert await c.read_writes("selfcheck-b", 10, 10, idle_ms=20) == [(i1, "event", {"n": 1})]
        c._down_until = time.monotonic() + 5  # a prompt-path timeout opened the breaker: the ack still goes through
        assert await c.ack_writes([i1])
        c._down_until = 0.0
        assert await c.read_writes("selfcheck-b", 10, 10, idle_ms=0) == []
        await c.rb.delete(c.WRITES)  # as after a FLUSHDB: NOGROUP fails the read, not Redis; the next read re-creates
        assert await c.read_writes("selfcheck-a", 10, 10) == [] and c.up
        assert await c.enqueue("event", {"n": 2})
        [(i2, _, row)] = await c.read_writes("selfcheck-a", 10, 10)
        assert row == {"n": 2} and await c.ack_writes([i2])
        # jobs stream
        assert await c.enqueue_job("selfcheck-job")
        [(j, job)] = await c.read_jobs("selfcheck-a", 10)
        assert job == "selfcheck-job"
        assert await c.ack_job(j)
        assert await c.read_jobs("selfcheck-a", 10) == []
        # pub/sub; a killed subscriber connection resubscribes, clears L1 and leaves the breaker closed
        got: list = []
        s = Cache(cfg()["redis_url"], cc)
        s.INVAL = c.INVAL
        s.rb.connection_pool.connection_kwargs["client_name"] = "selfcheck-sub"
        task = s.subscribe_inval(got.append)

        async def delivered() -> bool:
            got.clear()
            for _ in range(60):
                await c.publish_inval("selfcheck", user="selfcheck")
                await asyncio.sleep(0.05)
                if got:
                    return got[0] == {"scope": "selfcheck", "user": "selfcheck"}
            return False

        assert await delivered(), got
        s._l1_put("bundle:selfcheck", b"1", 60)
        subs = (await c.r.execute_command("CLIENT", "LIST", "TYPE", "pubsub")).decode().splitlines()
        subs = [ln.split()[0][3:] for ln in subs if " name=selfcheck-sub " in ln]
        for cid in subs:
            await c.r.execute_command("CLIENT", "KILL", "ID", cid)
        assert subs and await delivered() and s.up and not s._l1.get("bundle"), (subs, got, s.up)
        task.cancel()
        await s.close()
        # session turns keep the last maxlen
        for k in range(3):
            await c.push_turn("selfcheck", [k, k], 60, maxlen=2)
        assert [t.tolist() for t in await c.get_turns("selfcheck")] == [[1, 1], [2, 2]]
        await c.clear_turns("selfcheck")
        assert await c.get_turns("selfcheck") == []
        # rate counter
        n1, n2 = await c.hit_rate("selfcheck"), await c.hit_rate("selfcheck")
        assert n1 >= 1 and n2 in (n1 + 1, 1)  # 1: the minute rolled over between the calls
    finally:
        keys = [k async for k in c.rb.scan_iter(match="*selfcheck*", count=1000)]
        if keys:
            await c.rb.delete(*keys)
        assert not [k async for k in c.rb.scan_iter(match="*selfcheck*", count=1000)]
        await c.close()

    # Redis unreachable: every call answers empty, fast, without raising (a fresh Cache each, so each call really fails)
    log.disabled = True
    bad = "redis://127.0.0.1:1/0"
    cases = [
        (lambda x: x.start(), None), (lambda x: x.get_json("bundle:x"), None), (lambda x: x.set_json("bundle:x", 1, 9), None),
        (lambda x: x.get_vec("emb:x"), None), (lambda x: x.set_vec("emb:x", a, 9), None), (lambda x: x.delete("bundle:x"), None),
        (lambda x: x.semantic_get(a, "v", "p"), None), (lambda x: x.semantic_put("r", a, "v", "p", {}), None),
        (lambda x: x.enqueue("event", {}), False), (lambda x: x.read_writes("w", 10, 100), []), (lambda x: x.ack_writes(["0-1"]), False),
        (lambda x: x.enqueue_job("j"), False), (lambda x: x.read_jobs("w", 100), []), (lambda x: x.ack_job("0-1"), False),
        (lambda x: x.publish_inval("lib"), None), (lambda x: x.hit_rate("u"), 0), (lambda x: x.push_turn("s", a, 9), None),
        (lambda x: x.get_turns("s"), []), (lambda x: x.clear_turns("s"), None), (lambda x: x.close(), None),
    ]
    for call, want in cases:
        x = Cache(bad, cc)
        t = time.perf_counter()
        out = await call(x)
        assert out == want and type(out) is type(want) and time.perf_counter() - t < 0.2, (out, want)
    x = Cache(bad, cc)
    await x.start()
    assert not x.up
    await x.set_json("bundle:x", {"l1": True}, 9)  # L1-only while down
    assert await x.get_json("bundle:x") == {"l1": True}
    t = time.perf_counter()  # an empty read blocks like XREADGROUP BLOCK even while down, so reader loops never spin
    assert await x.read_writes("w", 10, 100) == [] and await x.read_jobs("w", 100) == []
    assert time.perf_counter() - t >= 0.19
    task = x.subscribe_inval(print)
    await asyncio.sleep(0.15)
    assert not task.done()
    task.cancel()
    x.l1_drop("bundle:")
    await x.close()
    print("cache self-check ok")


if __name__ == "__main__":
    asyncio.run(_check())
