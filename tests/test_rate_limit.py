"""Sliding-window rate limiter (M8-7): Cache.hit_rate over a Redis sorted set, one Lua call."""

import asyncio
import os
import time
import uuid

import pytest

from ctc.config import cfg
from ctc.storage.cache import Cache


def test_hit_rate_fails_open_when_redis_is_down():
    """No server needed: a closed port answers 0 (admit) within the 20 ms socket timeout, never raises."""

    async def go():
        c = Cache("redis://127.0.0.1:1/0", cfg()["cache"])
        t = time.perf_counter()
        n = await c.hit_rate("u")
        dt = time.perf_counter() - t
        await c.close()
        return n, dt

    n, dt = asyncio.run(go())
    assert n == 0 and dt < 0.2


def test_window_slides_instead_of_resetting():
    """Limit 3, window 2 s. A fixed window could reset between the 4th call and the first three; this one cannot."""
    url = os.environ.get("CTC_REDIS_URL", "")
    if not url or ":18303" in url:  # 18303 = the daemon's Redis
        pytest.skip("needs a scratch Redis: CTC_REDIS_URL unset or the daemon's Redis")
    user = f"ctc-test-{uuid.uuid4().hex[:8]}"

    async def go():
        c = Cache(url, cfg()["cache"])
        try:
            first = [await c.hit_rate(user, 2) for _ in range(3)]
            await asyncio.sleep(1.0)
            mid = await c.hit_rate(user, 2)  # t0 + 1 s: the first three are still inside the window
            ttl = await c.r.ttl(f"rl:{user}")
            await asyncio.sleep(1.1)
            last = await c.hit_rate(user, 2)  # t0 + 2.1 s: the first three slid out, the t0 + 1 s call and this one remain
            return first, mid, ttl, last
        finally:
            await c.r.delete(f"rl:{user}")
            await c.close()

    first, mid, ttl, last = asyncio.run(go())
    assert first == [1, 2, 3] and mid == 4 and 0 < ttl <= 2 and last == 2
