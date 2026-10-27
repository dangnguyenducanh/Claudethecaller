"""Postgres store (PLAN.md B3): capabilities, vectors, overrides, projects. Async psycopg 3 pool + pgvector.

SQL is written unqualified; each pooled connection's search_path picks the schema (ctc or ctc_skillret).
ponytail: those session SETs need a session-mode connection (direct, or Supabase's session pooler :5432); a transaction
pooler (:6543) drops them between statements. Move to schema-qualified SQL before shared mode uses one.
Pooled statements time out after 2 s (the prompt path's budget is 120 ms); bulk work raises it with
`set local statement_timeout` inside a transaction, as upsert() does.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import psycopg
from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ctc.ingestion.scanner import Capability, project_id
from ctc.storage.local import _STOP

SCHEMA_SQL = Path(__file__).with_name("schema.sql")
_CATALOG_COLS = "id, kind, name, namespace, invoke, description, summary, triggers, cluster_id, path, hash"

# Two channels. Dense: best cosine per cap over the n nearest vectors, computed in RAM (refresh_catalog loads them).
# Sparse, the only round trip: websearch_to_tsquery over 'tok1 or tok2 …' (never raises on odd input, unlike to_tsquery: unaccent
# turns 'ʼ' into a quote; and 'ʺ' into '"', which websearch reads as a phrase, hence the replace);
# no tokens -> no query at all.
# Dense candidates come from the in-RAM vector matrix (refresh_catalog); only the keyword channel goes to Postgres.
SPARSE_SQL = """
select c.id as cap_id, ts_rank_cd(c.tsv, q) as score
from capabilities c, websearch_to_tsquery('simple', replace(unaccent_i(%(q)s), '"', ' ')) q
where c.tsv @@ q order by score desc limit %(k)s
"""

UPSERT_SQL = """
with up as (
  insert into capabilities (id, kind, name, namespace, invoke, description, body, path, hash)
  select * from unnest(%s::text[], %s::text[], %s::text[], %s::text[], %s::text[], %s::text[], %s::text[], %s::text[], %s::text[])
  on conflict (id) do update set kind = excluded.kind, invoke = excluded.invoke, description = excluded.description,
    body = excluded.body, path = excluded.path, hash = excluded.hash, updated_at = now(),
    enricher_version = case when capabilities.hash = excluded.hash then capabilities.enricher_version end
  where (capabilities.hash, capabilities.path, capabilities.kind) is distinct from (excluded.hash, excluded.path, excluded.kind)
  returning id, case when xmax = 0 then 'added' else 'changed' end as what
), gone as (
  delete from capabilities where namespace = any(%s) and id <> all(%s) returning id, 'removed' as what
)
select * from up union all select * from gone
"""


@dataclass
class Diff:
    added: list[str]
    changed: list[str]
    removed: list[str]


class Store:
    schema: str
    pool: AsyncConnectionPool
    catalog: dict[str, dict]
    library_version: str

    @classmethod
    async def open(cls, dsn: str, schema: str = "ctc", pool_min: int = 1, pool_max: int = 5) -> Store:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
            raise ValueError(f"bad schema name {schema!r}")
        # schema comment = md5 of the applied script: steady-state opens skip the DDL (and its ACCESS EXCLUSIVE locks)
        sql = SCHEMA_SQL.read_text().replace("{schema}", schema)
        ver = hashlib.md5(sql.encode()).hexdigest()
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            cur = await conn.execute("select obj_description(to_regnamespace(%s), 'pg_namespace')", (schema,))
            if (await cur.fetchone())[0] != ver:
                await conn.execute(f"{sql}\ncomment on schema {schema} is '{ver}';")

        async def configure(conn: psycopg.AsyncConnection) -> None:
            # search_path first: register_vector_async looks the type up through it
            await conn.execute(f"set search_path to {schema}, extensions, public; set hnsw.ef_search = 200; set statement_timeout = '2s'")
            await register_vector_async(conn)

        self = cls()
        self.schema, self.catalog, self.library_version = schema, {}, ""
        self.pool = AsyncConnectionPool(
            dsn, min_size=pool_min, max_size=pool_max, open=False, configure=configure,
            kwargs={"autocommit": True, "prepare_threshold": None, "row_factory": dict_row},
        )
        await self.pool.open(wait=True)
        await self.refresh_catalog()
        return self

    async def close(self) -> None:
        await self.pool.close()

    async def _run(self, go):
        """await go(conn) on a pooled connection. One the server already dropped (pooler/NAT idle cut, DB restart) is
        discarded by the pool and the call moves to the next; at most pool max_size dead ones can be queued.
        ponytail: a cut between commit and reply re-runs the statement; every write here is idempotent, the writer's
        counters (turns, events) can double in that window."""
        for left in range(self.pool.max_size, -1, -1):
            async with self.pool.connection() as conn:
                try:
                    return await go(conn)
                except psycopg.OperationalError:
                    if not left or not conn.closed:  # e.g. QueryCanceled leaves the connection open: a real error
                        raise

    # generic helpers; rows are dicts
    async def fetch(self, sql: str, params=None) -> list[dict]:
        async def go(conn):
            return await (await conn.execute(sql, params)).fetchall()
        return await self._run(go)

    async def fetchrow(self, sql: str, params=None) -> dict | None:
        async def go(conn):
            return await (await conn.execute(sql, params)).fetchone()
        return await self._run(go)

    async def fetchval(self, sql: str, params=None):
        row = await self.fetchrow(sql, params)
        return next(iter(row.values())) if row else None

    async def execute(self, sql: str, params=None) -> int:
        async def go(conn):
            return (await conn.execute(sql, params)).rowcount
        return await self._run(go)

    async def executemany(self, sql: str, seq) -> None:
        async def go(conn):
            async with conn.cursor() as cur:
                await cur.executemany(sql, seq)
        await self._run(go)

    # catalog: every capability minus body, in RAM for the search hot path
    async def refresh_catalog(self) -> None:
        rows = await self.fetch(f"select {_CATALOG_COLS} from capabilities")
        self.catalog = {r["id"]: r for r in rows}
        # ponytail: every capability vector in RAM per worker (6.3k x 1024 floats = 26 MB) so a route makes no DB hop for
        # dense search (Supabase is ~40 ms away; the hook budget is 120 ms). Brute force is exact; past ~100k vectors use
        # a HNSW library or go back to the pgvector index.
        await self._load_vectors()
        self.library_version = await self.compute_library_version()

    async def _load_vectors(self) -> None:
        """Binary transfer (4 KB/vector, not ~10 KB of text), keyset chunks so each statement stays under the 2 s timeout."""
        ids, vecs, last = [], [], ("", "")
        async with self.pool.connection() as conn, conn.cursor(binary=True) as cur:
            while True:
                await cur.execute("select cap_id, text_hash, embedding from cap_vectors where (cap_id, text_hash) > (%s, %s)"
                                  " order by cap_id, text_hash limit 2000", last)
                rows = await cur.fetchall()
                if not rows:
                    break
                ids += [r["cap_id"] for r in rows]
                vecs += [np.asarray(r["embedding"].to_numpy(), dtype=np.float32) for r in rows]  # binary loader -> pgvector Vector
                last = (rows[-1]["cap_id"], rows[-1]["text_hash"])
        self._vids = np.array(ids, dtype=object)
        self._vecs = np.stack(vecs) if vecs else np.zeros((0, 1), np.float32)
        self._vdirty = False

    def get(self, cap_id: str) -> dict:
        return self.catalog[cap_id]

    async def compute_library_version(self) -> str:
        return await self.fetchval(
            "select md5(coalesce(string_agg(id || hash || coalesce(enricher_version, ''), ',' order by id), '')) from capabilities"
        )

    async def upsert(self, caps: list[Capability], namespaces: list[str]) -> Diff:
        """Insert new, update changed (hash or path: plugin upgrades move path), delete caps of `namespaces` not in `caps`.
        A content change (hash) nulls enricher_version so A1 re-enriches it; the old summary/triggers serve until then."""
        cols = [[getattr(c, f) for c in caps] for f in ("id", "kind", "name", "namespace", "invoke", "description", "body", "path", "hash")]

        async def go(conn):
            async with conn.transaction():
                await conn.execute("set local statement_timeout = '5min'")  # one statement for the whole library (SkillRet: ~10k caps)
                return await (await conn.execute(UPSERT_SQL, [*cols, namespaces, cols[0]])).fetchall()

        rows = await self._run(go)
        await self.refresh_catalog()
        return Diff(*(sorted(r["id"] for r in rows if r["what"] == w) for w in ("added", "changed", "removed")))

    async def candidates(self, qv: np.ndarray, query: str, k: int = 50) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
        # ponytail: first 32 distinct tokens; ts_rank_cd cost grows superlinearly with OR terms (100 -> ~0.3 s, a pasted
        # traceback -> seconds). A longer prompt's tail only reaches the dense channel.
        toks = list(dict.fromkeys(t for t in re.findall(r"\w+", query.lower()) if t not in _STOP))[:32]
        sparse = await self.fetch(SPARSE_SQL, {"q": " or ".join(toks), "k": k}) if toks else []
        dense: dict[str, float] = {}
        if self._vdirty:  # vectors written since the last load (build_index): reload once, here
            await self._load_vectors()
        if len(self._vids):
            sims = self._vecs @ (np.asarray(qv, dtype=np.float32) / (np.linalg.norm(qv) or 1.0))  # stored L2-normalized
            top = np.argpartition(-sims, min(k * 4, len(sims)) - 1)[: k * 4]
            for i in top[np.argsort(-sims[top])]:  # best vector per capability, like the old SQL's max(1 - d)
                dense.setdefault(self._vids[i], float(sims[i]))
        # (cap_id, cosine) and (cap_id, raw ts_rank_cd), best first; hybrid's score fusion normalises the keyword scores by their max
        return list(dense.items())[:k], [(r["cap_id"], float(r["score"])) for r in sparse]

    async def overrides(self, project_id: str, user_id: str = "local") -> dict[str, str]:
        rows = await self.fetch(
            "select distinct on (cap_id) cap_id, action from overrides where user_id = %s and project in (%s, '*') order by cap_id, project = '*'",
            (user_id, project_id),
        )
        return {r["cap_id"]: r["action"] for r in rows}

    async def set_override(self, project: str, cap_id: str, action: str | None, user_id: str = "local") -> None:
        if action is None:
            await self.execute("delete from overrides where user_id = %s and project = %s and cap_id = %s", (user_id, project, cap_id))
        else:
            await self.execute(
                "insert into overrides (user_id, project, cap_id, action) values (%s, %s, %s, %s)"
                " on conflict (user_id, project, cap_id) do update set action = excluded.action, at = now()",
                (user_id, project, cap_id, action),
            )

    async def set_enrichment(self, cap_id: str, e: dict, version: str) -> None:
        # library_version moves with enricher_version; the enricher calls refresh_catalog() once at the end of a batch
        await self.execute(
            "update capabilities set summary = %s, triggers = %s, enricher_version = %s, updated_at = now() where id = %s",
            (e["summary"], list(e["triggers"]), version, cap_id),
        )
        if cap_id in self.catalog:
            self.catalog[cap_id].update(summary=e["summary"], triggers=list(e["triggers"]))

    async def set_cluster(self, cap_id: str, cluster_id: str | None) -> None:
        await self.execute("update capabilities set cluster_id = %s, updated_at = now() where id = %s", (cluster_id, cap_id))
        if cap_id in self.catalog:
            self.catalog[cap_id]["cluster_id"] = cluster_id

    async def ensure_project(self, cwd: str, user_id: str = "local") -> str:
        """Upsert the projects row for cwd and bump last_active; returns its unique name (basename, then ~2, ~3, …)."""
        path = Path(cwd).resolve()
        params = {"u": user_id, "id": project_id(cwd), "base": path.name or "root", "path": str(path)}
        for _ in range(5):  # a concurrent insert can take the free name between our check and insert
            try:
                return await self.fetchval(
                    """
                    insert into projects (user_id, id, name, path)
                    select %(u)s, %(id)s, nm, %(path)s
                    from generate_series(1, 10000) n, lateral (select case when n = 1 then %(base)s else %(base)s || '~' || n end as nm) x
                    where not exists (select 1 from projects p where p.user_id = %(u)s and p.name = x.nm)
                    limit 1
                    on conflict (user_id, id) do update set last_active = now()
                    returning name
                    """,
                    params,
                )
            except psycopg.errors.UniqueViolation:
                continue
        raise RuntimeError(f"could not name project {cwd}")

    # vectors (indexer); stored L2-normalized
    async def vector_keys(self) -> set[tuple[str, str]]:
        return {(r["cap_id"], r["text_hash"]) for r in await self.fetch("select cap_id, text_hash from cap_vectors")}

    async def insert_vectors(self, rows: list[tuple[str, str, str, str, np.ndarray]]) -> None:
        def unit(v):
            v = np.asarray(v, dtype=np.float32)
            return v / max(float(np.linalg.norm(v)), 1e-9)

        await self.executemany(
            "insert into cap_vectors (cap_id, text_hash, model, text, embedding) values (%s, %s, %s, %s, %s) on conflict do nothing",
            [(c, h, m, t, unit(v)) for c, h, m, t, v in rows],
        )
        self._vdirty = True

    async def delete_vectors(self, keys: list[tuple[str, str]]) -> None:
        await self.execute(
            "delete from cap_vectors where (cap_id, text_hash) in (select * from unnest(%s::text[], %s::text[]))",
            ([k[0] for k in keys], [k[1] for k in keys]),
        )
        self._vdirty = True

    async def counts(self) -> dict:
        return await self.fetchrow("select (select count(*) from capabilities) as capabilities, (select count(*) from cap_vectors) as vectors")


if __name__ == "__main__":
    import asyncio
    import tempfile
    import time

    from ctc.config import cfg

    SELF = "ctc_selfcheck"

    async def drop(dsn: str) -> None:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"drop schema if exists {SELF} cascade")

    def cap(name: str, desc: str, ns: str = "user", h: str = "h1") -> Capability:
        return Capability(f"{ns}:{name}", "skill", name, ns, desc, "body", f"/x/{name}/SKILL.md", h)

    async def opens(dsn: str, n: int) -> None:
        for x in await asyncio.gather(*(Store.open(dsn, SELF, pool_max=1) for _ in range(n))):
            await x.close()

    async def check(dsn: str) -> None:
        await opens(dsn, 4)  # 4 workers starting at once on a fresh DB: the advisory lock serializes them
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"comment on schema {SELF} is null")  # forget the version: schema.sql applies again
            await opens(dsn, 4)
            assert (await (await conn.execute(f"select obj_description('{SELF}'::regnamespace)")).fetchone())[0]
            # steady state takes no DDL locks: an open finishes while another session holds a table lock
            async with conn.transaction():
                await conn.execute(f"lock table {SELF}.capabilities in access share mode")
                await asyncio.wait_for(opens(dsn, 1), 5)
        s = await Store.open(dsn, SELF)
        try:
            rng = np.random.default_rng(0)
            caps = [cap(f"c{i:02d}", f"synthetic capability number {i}") for i in range(30)]
            caps += [cap("cafe", "Brew a café au lait"), cap("code-review", "Look over a diff"), cap("plug", "x", ns="other")]
            d = await s.upsert(caps, ["user", "other"])
            assert (len(d.added), d.changed, d.removed) == (33, [], []), d
            assert s.get("user:cafe")["description"] == "Brew a café au lait" and len(s.catalog) == 33
            v1 = s.library_version
            d = await s.upsert(caps, ["user", "other"])
            assert d == Diff([], [], []) and s.library_version == v1, d
            caps2 = [c for c in caps if c.name != "c29"]
            caps2[0] = cap("c00", "synthetic capability number 0", h="h2")
            d = await s.upsert(caps2 + [cap("new", "brand new")], ["user"])  # 'other' not listed: its caps stay
            assert d == Diff(["user:new"], ["user:c00"], ["user:c29"]), d
            assert s.library_version != v1 and "other:plug" in s.catalog
            try:
                s.get("user:c29")
                raise AssertionError("removed cap still in catalog")
            except KeyError:
                pass

            # dense: 2 vectors per cap; expected = best cosine per cap
            ids = sorted(s.catalog)
            vecs = {(i, f"t{j}"): rng.normal(size=1024).astype(np.float32) for i in ids for j in range(2)}
            await s.insert_vectors([(i, h, "m", "text", v) for (i, h), v in vecs.items()])
            assert await s.vector_keys() == set(vecs)
            assert await s.counts() == {"capabilities": len(ids), "vectors": len(vecs)}
            qv = rng.normal(size=1024).astype(np.float32)
            best = {}
            for (i, _), v in vecs.items():
                best[i] = max(best.get(i, -2), float(v @ qv / np.linalg.norm(v) / np.linalg.norm(qv)))
            want = sorted(best.items(), key=lambda x: -x[1])[:5]

            n = 0
            orig = psycopg.AsyncCursor.execute

            async def counted(self, *a, **kw):
                nonlocal n
                n += 1
                return await orig(self, *a, **kw)

            await s.candidates(qv, "warm", k=5)  # loads the vectors written above (dirty flag) before counting
            psycopg.AsyncCursor.execute = counted
            dense, sparse = await s.candidates(qv, "how do I make a CAFE", k=5)
            psycopg.AsyncCursor.execute = orig
            assert n == 1, f"{n} round trips"
            assert [i for i, _ in dense] == [i for i, _ in want], (dense, want)
            assert all(abs(a[1] - b[1]) < 1e-4 for a, b in zip(dense, want))
            assert [i for i, _ in sparse] == ["user:cafe"], sparse
            assert (await s.candidates(qv, "café", 5))[1][0][0] == "user:cafe"
            assert (await s.candidates(qv, "review", 5))[1][0][0] == "user:code-review"  # hyphenated name
            assert (await s.candidates(qv, "how to do the", 5))[1] == []  # stopwords only
            assert (await s.candidates(qv, "ʼa ⑴⑵ (x) 'y", 5)) is not None  # odd input never raises
            assert [i for i, _ in (await s.candidates(qv, "obʺekt cafe", 5))[1]] == ["user:cafe"]  # ʺ unaccents to '"'
            t0 = time.perf_counter()
            assert (await s.candidates(qv, "cafe " + " ".join(f"tok{i}" for i in range(5000)), 5))[1][0][0] == "user:cafe"
            assert (await s.candidates(qv, "error " * 5000 + "cafe", 5))[1][0][0] == "user:cafe"  # tokens deduped
            assert time.perf_counter() - t0 < 1, "long prompt not capped"
            await s.set_enrichment("user:c01", {"summary": "zebra crossing helper", "triggers": ["walk the zebra"]}, "e1")
            assert (await s.candidates(qv, "zebra", 5))[1][0][0] == "user:c01" and s.get("user:c01")["summary"].startswith("zebra")
            assert await s.compute_library_version() != s.library_version  # enricher_version feeds it
            caps2 = caps2 + [cap("new", "brand new")]
            caps2[1] = cap("c01", "now about giraffes", h="h2")
            assert (d := await s.upsert(caps2, ["user"])) == Diff([], ["user:c01"], []), d
            assert await s.fetchval("select enricher_version from capabilities where id = 'user:c01'") is None  # re-enrich
            await s.set_cluster("user:c02", "user:c01")
            assert s.get("user:c02")["cluster_id"] == "user:c01"

            t = []
            for _ in range(20):
                t0 = time.perf_counter()
                await s.candidates(qv, "brew coffee review", 50)
                t.append((time.perf_counter() - t0) * 1000)
            print(f"candidates(): min {min(t):.2f} ms, median {sorted(t)[10]:.2f} ms over 20 calls ({len(vecs)} vectors)")

            await s.delete_vectors([("user:c00", "t0"), ("user:c00", "t1")])
            assert await s.counts() == {"capabilities": len(ids), "vectors": len(vecs) - 2}

            # overrides: project row beats '*'
            await s.set_override("*", "user:c03", "block")
            await s.set_override("p1", "user:c03", "pin")
            await s.set_override("*", "user:c04", "disable")
            assert await s.overrides("p1") == {"user:c03": "pin", "user:c04": "disable"}
            assert await s.overrides("p2") == {"user:c03": "block", "user:c04": "disable"}
            await s.set_override("p1", "user:c03", None)
            assert (await s.overrides("p1"))["user:c03"] == "block"

            # projects: same basename in two dirs -> app, app~2; same dir again -> same name
            root = Path(tempfile.mkdtemp())
            a, b = root / "one" / "app", root / "two" / "app"
            a.mkdir(parents=True), b.mkdir(parents=True)
            assert await s.ensure_project(str(a)) == "app"
            assert await s.ensure_project(str(b)) == "app~2"
            assert await s.ensure_project(str(a)) == "app" and await s.ensure_project(str(b)) == "app~2"
            assert await s.fetchval("select count(*) from projects") == 2
            assert await s.ensure_project(str(a), user_id="u2") == "app"  # names are unique per user

            try:  # hot-path guard: 2 s statement timeout, and a timeout is not retried
                await s.fetchval("select pg_sleep(3)")
                raise AssertionError("no statement timeout")
            except psycopg.errors.QueryCanceled:
                pass
        finally:
            await s.close()

        # a pooled connection the server dropped is replaced, not surfaced
        s = await Store.open(dsn, SELF, pool_min=1, pool_max=1)
        try:
            await s.execute("set idle_session_timeout = '500ms'")
            await asyncio.sleep(1.2)
            assert await s.fetchval("select 1") == 1
        finally:
            await s.close()

    async def main() -> None:
        dsn = cfg()["database_url"]
        await drop(dsn)
        try:
            await check(dsn)
        finally:
            await drop(dsn)
        s = await Store.open(dsn)  # real schema "ctc", so later steps find it
        print("schema ctc ready:", await s.counts(), "library_version", s.library_version)
        await s.close()
        print("store self-check ok")

    asyncio.run(main())
