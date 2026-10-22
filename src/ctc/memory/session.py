"""Session memory (PLAN.md B7, "Memory design"): project profile vector, session turn vector, query-vector blend.

Project vector: `proj:{user}:{project_id}` {hash, vec} (L1/L2) in front of projects(profile_hash, embedding). The profile
hash is recomputed on every call (a handful of small file reads, off the loop), so an edited CLAUDE.md re-embeds on the
next prompt. Session turns live in Redis (`sess:{id}:turns`) so any worker serves the next turn; while Redis is down,
an in-process LRU of deques stands in. Every vector here is unit length.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from collections import OrderedDict, deque
from pathlib import Path

import numpy as np

from ctc.config import cfg
from ctc.ingestion.scanner import project_id

log = logging.getLogger(__name__)
MANIFESTS = ("pyproject.toml", "package.json", "Cargo.toml", "go.mod", "requirements.txt", "Gemfile", "pom.xml")
_HEAD = 400  # chars of each manifest in the profile text
_TURNS = 20
_LOCAL_MAX = 1000
_local: OrderedDict[str, deque] = OrderedDict()  # session_id -> turn vectors, only while Redis is down


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).ravel()
    return v / max(float(np.linalg.norm(v)), 1e-9)


def project_profile(cwd: str) -> tuple[str, str]:
    """(sha256 over CLAUDE.md, .claude/**/memory/*.md, manifests, .git/HEAD; CLAUDE.md + manifest heads [:2000]).
    Missing files are skipped, and so is any file whose real path is outside cwd (symlinks are never followed out)."""
    root = Path(cwd).resolve()
    files = [root / "CLAUDE.md"]
    claude = root / ".claude"
    if claude.is_dir() and claude.resolve().is_relative_to(root):
        # memory dirs sit at .claude/memory, .claude/*/memory, .claude/*/*/memory (projects/<slug>/memory): prune deeper
        # levels and worktrees/ (full checkouts); os.walk never follows dir links (no loops, no duplicates)
        # ponytail: lists every .claude/*/* dir, <1 ms in a repo, ~10 ms at cwd=$HOME; fixed globs + a no-symlink check if it matters
        mem = []
        for d, ds, fs in os.walk(claude):
            rel = Path(d).relative_to(claude).parts
            ds[:] = [x for x in ds if len(rel) < 2 and x != "worktrees" or len(rel) == 2 and x == "memory"]
            mem += [Path(d) / f for f in fs if f.endswith(".md")] if rel and rel[-1] == "memory" else []
        files += sorted(mem)
    files += [root / m for m in MANIFESTS] + [root / ".git" / "HEAD"]
    h, text = hashlib.sha256(), {}
    for p in files:
        try:
            r = p.resolve()  # RuntimeError: symlink loop
            if not (r.is_relative_to(root) and r.is_file()):
                continue
            data = r.read_bytes()
        except (OSError, RuntimeError):
            continue
        rel = p.relative_to(root).as_posix()
        h.update(rel.encode() + b"\0" + data + b"\0")
        text[rel] = data.decode(errors="replace")
    parts = [text.get("CLAUDE.md", "")] + [f"{m}:\n{text[m][:_HEAD]}" for m in MANIFESTS if m in text]
    return h.hexdigest(), "\n\n".join(p for p in parts if p)[:2000]


def _model_hash(h: str, embedder) -> str:
    """The stored vector belongs to one embedder, so a model change is a profile change (cfg name until TEI's id is learned)."""
    return hashlib.sha256(f"{embedder.model_version or cfg()['embed_model']}\0{h}".encode()).hexdigest()


async def project_vector(cwd: str, store, cache, embedder, user_id: str = "local") -> np.ndarray | None:
    """Profile vector for cwd. None when the projects row does not exist yet, the profile has no text, or anything fails."""
    if cfg()["mode"] == "shared":  # cwd is a client path: the daemon must not read its own disk there (PLAN: shared mode)
        return None  # ponytail: no project part in shared mode until the hook sends the profile text + hash
    pid = project_id(cwd)
    key = f"proj:{user_id}:{pid}"
    try:
        h, text = await asyncio.to_thread(project_profile, cwd)
        h = _model_hash(h, embedder)
        got = await cache.get_json(key)
        if got and got["hash"] == h:
            return None if got["vec"] is None else np.asarray(got["vec"], dtype=np.float32)
        row = await store.fetchrow("select profile_hash, embedding from projects where user_id = %s and id = %s", (user_id, pid))
        if row is None:
            return None
        if row["profile_hash"] == h and (row["embedding"] is not None or not text):
            vec = None if row["embedding"] is None else row["embedding"].to_numpy()  # pgvector.Vector
        else:  # new or changed profile
            # query side: the vector is blended into the prompt's query vector, so it lives in query space
            vec = _unit((await embedder.embed([text], "query"))[0]) if text else None
            await store.execute(
                "update projects set profile_hash = %s, embedding = %s where user_id = %s and id = %s", (h, vec, user_id, pid)
            )
        await cache.set_json(key, {"hash": h, "vec": vec}, cfg()["cache"]["ttl"]["proj"])  # vec None is cached too: no text
        return vec
    except Exception:  # fail-open: the blend just drops the project part
        log.exception("project_vector(%s) failed", cwd)
        return None


async def session_vector(session_id: str, qv, cache) -> np.ndarray | None:
    """Mean of the session's previous turns (None if none, or on a topic shift, which clears them first); pushes qv."""
    qv = _unit(qv)
    turns = await cache.get_turns(session_id)  # [] without a round trip while down
    if cache.up:
        _local.clear()  # Redis answers again: the outage's turns must not resurface in a later outage
    else:  # down before, or that read just failed
        turns = list(_local.get(session_id, ()))
    mean = _unit(np.mean(turns, axis=0)) if turns else None
    if mean is not None and float(mean @ qv) < cfg()["topic_shift_below"]:
        mean = None
        _local.pop(session_id, None)
        await cache.clear_turns(session_id)  # no-op while down
    await cache.push_turn(session_id, qv, cfg()["cache"]["ttl"]["sess"], _TURNS)
    if not cache.up:
        d = _local.pop(session_id, None) or deque(maxlen=_TURNS)
        d.append(qv)
        _local[session_id] = d  # re-insert = most recently used
        if len(_local) > _LOCAL_MAX:
            _local.popitem(last=False)
    return mean


def blend(prompt_v, session_v=None, project_v=None, memory_v=None, w: dict | None = None) -> np.ndarray:
    """unit(sum of weight * unit(part)) over the parts present. Dividing by the present weights' sum (renormalizing)
    would not change the direction, so the final unit() does it."""
    w = {**cfg()["blend"], "memory": cfg()["memory_weight"], **(w or {})}
    parts = {"prompt": prompt_v, "session": session_v, "project": project_v, "memory": memory_v}
    return _unit(sum(w[k] * _unit(v) for k, v in parts.items() if v is not None))


async def _check() -> None:
    import tempfile

    import psycopg

    from ctc.embedding.embedder import Embedder
    from ctc.storage.cache import Cache
    from ctc.storage.store import Store

    rng = np.random.default_rng(0)
    a = _unit(rng.standard_normal(1024))
    b = rng.standard_normal(1024)
    b = _unit(b - (b @ a) * a)
    c = rng.standard_normal(1024)
    c = _unit(c - (c @ a) * a - (c @ b) * b)
    near = _unit(0.9 * a + np.sqrt(1 - 0.81) * b)  # cosine 0.9 with a

    # blend: unit output, weights as ratios of the parts present, parts unit-normalized first
    W = cfg()["blend"]
    assert np.allclose(blend(a), a, atol=1e-6)
    for out, (x, y, want) in [
        (blend(a, b), (a, b, W["prompt"] / W["session"])),
        (blend(a, None, b), (a, b, W["prompt"] / W["project"])),
        (blend(a, memory_v=b), (a, b, W["prompt"] / cfg()["memory_weight"])),
        (blend(a, None, b, w={"prompt": 1, "project": 1}), (a, b, 1.0)),
        (blend(3 * a, 10 * b), (a, b, W["prompt"] / W["session"])),
    ]:
        assert abs(np.linalg.norm(out) - 1) < 1e-5 and abs((out @ x) / (out @ y) - want) < 1e-4, (out @ x, out @ y, want)
    out = blend(a, b, c)
    assert abs(np.linalg.norm(out) - 1) < 1e-5 and abs(out @ a / (out @ c) - W["prompt"] / W["project"]) < 1e-4

    # project_profile: missing files skipped, CLAUDE.md edits change the hash, symlinks out of cwd ignored
    d, outside = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
    h0, t0 = project_profile(str(d))
    assert t0 == "" and h0 == hashlib.sha256().hexdigest()
    (d / "CLAUDE.md").write_text("# demo\nRouter for coding agents; use uv.")
    h1, t1 = project_profile(str(d))
    assert h1 != h0 and t1.startswith("# demo")
    (d / "pyproject.toml").write_text('[project]\nname = "demo"\n' + "x" * 1000)
    h2, t2 = project_profile(str(d))
    assert h2 != h1 and "pyproject.toml:\n[project]" in t2 and len(t2) < len(t1) + _HEAD + 40
    (d / ".claude" / "agents" / "memory").mkdir(parents=True)
    (d / ".claude" / "agents" / "memory" / "note.md").write_text("prefers ruff")
    (d / ".claude" / "agents" / "memory" / "note.txt").write_text("not a memory")
    h3, t3 = project_profile(str(d))
    assert h3 != h2 and t3 == t2  # memory files feed the hash, not the text
    (d / ".claude" / "agents" / "memory" / "note.txt").write_text("still not a memory")
    assert project_profile(str(d))[0] == h3
    (outside / "secret.md").write_text("outside cwd")
    (outside / "package.json").write_text('{"name": "outside"}')
    (d / ".claude" / "memory").mkdir()
    (d / ".claude" / "memory" / "link.md").symlink_to(outside / "secret.md")
    (d / "package.json").symlink_to(outside / "package.json")
    (d / ".claude" / "loop").symlink_to(d / ".claude")  # a directory loop: os.walk does not follow it
    (d / "go.mod").symlink_to(d / "go.mod")  # a file symlink loop: skipped
    assert project_profile(str(d)) == (h3, t3)
    (d / ".git").mkdir()
    (d / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    h4 = project_profile(str(d))[0]
    (d / ".git" / "HEAD").write_text("ref: refs/heads/other\n")
    assert len({h3, h4, project_profile(str(d))[0]}) == 3
    h5 = project_profile(str(d))[0]
    for far in ("worktrees/wt/memory", "worktrees/wt/.claude/memory", "a/b/c/memory", "a/b/memory/memory"):
        (d / ".claude" / far).mkdir(parents=True)
        (d / ".claude" / far / "x.md").write_text("pruned: worktrees/ and deeper than .claude/*/*/memory")
    assert project_profile(str(d))[0] == h5
    (d / ".claude" / "projects" / "slug" / "memory").mkdir(parents=True)
    (d / ".claude" / "projects" / "slug" / "memory" / "m.md").write_text("auto memory")
    assert project_profile(str(d))[0] != h5
    (d / "CLAUDE.md").write_text("long " * 1000)
    assert len(project_profile(str(d))[1]) == 2000
    (d / "CLAUDE.md").write_text("# demo\nRouter for coding agents; use uv.")

    # project_vector: throwaway schema, real embedder, real Redis
    dsn, schema, user = cfg()["database_url"], "ctc_selfcheck_session", "selfcheck"

    async def drop() -> None:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"drop schema if exists {schema} cascade")

    await drop()
    store = await Store.open(dsn, schema)
    cache = Cache(cfg()["redis_url"], cfg()["cache"])
    await cache.start()
    assert cache.up, "redis unreachable"
    log_cache = logging.getLogger("ctc.storage.cache")
    key = f"proj:{user}:{project_id(d)}"
    emb, calls = Embedder(cfg()["embed_url"]), {"embed": 0, "db": 0}
    orig_embed, orig_fetchrow = emb.embed, store.fetchrow

    async def embed(*x, **kw):
        calls["embed"] += 1
        return await orig_embed(*x, **kw)

    async def fetchrow(*x, **kw):
        calls["db"] += x[0].startswith("select profile_hash")  # not ensure_project's own fetchrow
        return await orig_fetchrow(*x, **kw)

    emb.embed, store.fetchrow = embed, fetchrow
    sid = "selfcheck-session"
    try:
        await cache.delete(key)
        assert await project_vector(str(d), store, cache, emb, user) is None and calls == {"embed": 0, "db": 1}  # no row yet
        await store.ensure_project(str(d), user)
        v1 = await project_vector(str(d), store, cache, emb, user)
        assert v1 is not None and abs(np.linalg.norm(v1) - 1) < 1e-5 and calls == {"embed": 1, "db": 2}
        row = await orig_fetchrow("select profile_hash, embedding from projects where user_id = %s", (user,))
        assert row["profile_hash"] == _model_hash(project_profile(str(d))[0], emb) and np.allclose(row["embedding"].to_numpy(), v1, atol=1e-6)
        assert np.allclose(await project_vector(str(d), store, cache, emb, user), v1) and calls == {"embed": 1, "db": 2}  # L1
        cache._l1.clear()
        assert np.allclose(await project_vector(str(d), store, cache, emb, user), v1) and calls == {"embed": 1, "db": 2}  # L2
        await cache.delete(key)
        assert np.allclose(await project_vector(str(d), store, cache, emb, user), v1) and calls == {"embed": 1, "db": 3}  # row
        (d / "CLAUDE.md").write_text("# demo\nNow a Rust CLI built with cargo.")
        v2 = await project_vector(str(d), store, cache, emb, user)
        assert calls == {"embed": 2, "db": 4} and not np.allclose(v1, v2)  # stale cache hash -> DB -> re-embed + update
        assert await orig_fetchrow("select profile_hash from projects where user_id = %s", (user,)) == {"profile_hash": _model_hash(project_profile(str(d))[0], emb)}
        down = Cache("redis://127.0.0.1:1/0", cfg()["cache"])
        log_cache.disabled = True
        assert np.allclose(await project_vector(str(d), store, down, emb, user), v2) and calls == {"embed": 2, "db": 5}  # Redis down: DB row
        log_cache.disabled = False
        real, emb.model_version = emb.model_version, "selfcheck/other-model"
        assert np.allclose(await project_vector(str(d), store, cache, emb, user), v2, atol=1e-4)  # same TEI underneath
        assert calls == {"embed": 3, "db": 6}  # model change: cache + row hash miss -> re-embed
        emb.model_version = real
        cfg()["mode"] = "shared"
        assert await project_vector(str(d), store, cache, emb, user) is None and calls == {"embed": 3, "db": 6}  # no disk read
        cfg()["mode"] = "local"
        (d / "CLAUDE.md").write_text("# demo\nchanged again")
        dead, log.disabled = Embedder("http://127.0.0.1:1"), True  # the expected traceback stays out of the output
        assert await project_vector(str(d), store, cache, dead, user) is None  # embedder fails
        log.disabled = False
        await dead.aclose()
        empty = Path(tempfile.mkdtemp())
        await store.ensure_project(str(empty), user)
        assert await project_vector(str(empty), store, cache, emb, user) is None and calls["embed"] == 3  # no text: no embed
        n = calls["db"]
        assert await project_vector(str(empty), store, cache, emb, user) is None and calls["db"] == n  # ... and cached
        await cache.delete(f"proj:{user}:{project_id(empty)}")

        # session_vector on Redis: mean excludes the current turn, topic shift clears, keeps the last 20
        await cache.clear_turns(sid)
        assert await session_vector(sid, a, cache) is None  # no previous turns
        assert np.allclose(await session_vector(sid, near, cache), a, atol=1e-6)  # previous turn only, not `near`
        assert np.allclose(await session_vector(sid, a, cache), _unit(a + near), atol=1e-6)
        assert len(await cache.get_turns(sid)) == 3
        assert await session_vector(sid, 5 * b, cache) is None  # cosine(b, mean) < topic_shift_below
        turns = await cache.get_turns(sid)
        assert len(turns) == 1 and np.allclose(turns[0], b, atol=1e-6)
        assert np.allclose(await session_vector(sid, b, cache), b, atol=1e-6)
        for _ in range(25):
            await session_vector(sid, b, cache)
        assert len(await cache.get_turns(sid)) == _TURNS and not _local  # the fallback stays unused while Redis is up
    finally:
        await cache.delete(key)
        await cache.clear_turns(sid)
        await cache.close()
        await store.close()
        await emb.aclose()
        await drop()

    # session_vector with Redis down: same behaviour from the in-process deques, LRU-capped
    log_cache.disabled = True
    down = Cache("redis://127.0.0.1:1/0", cfg()["cache"])
    assert await session_vector(sid, a, down) is None and not down.up
    assert np.allclose(await session_vector(sid, near, down), a, atol=1e-6)
    assert np.allclose(await session_vector(sid, a, down), _unit(a + near), atol=1e-6)
    assert await session_vector(sid, b, down) is None and len(_local[sid]) == 1
    for _ in range(25):
        await session_vector(sid, b, down)
    assert len(_local[sid]) == _TURNS
    for i in range(_LOCAL_MAX):
        await session_vector(f"selfcheck-{i}", a, down)
    assert len(_local) == _LOCAL_MAX and sid not in _local and "selfcheck-0" in _local
    await down.close()
    up = Cache(cfg()["redis_url"], cfg()["cache"])
    await up.start()
    try:
        await session_vector(sid, a, up)
        assert not _local  # Redis is back: the outage's turns are dropped, so a later outage starts clean
    finally:
        await up.clear_turns(sid)
        await up.close()
    print("session self-check ok")


if __name__ == "__main__":
    asyncio.run(_check())
