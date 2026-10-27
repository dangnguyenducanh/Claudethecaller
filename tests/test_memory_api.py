"""m7 O6: /api/memories/{feed,feed/counts,timeline,context}, /api/observations/*, /api/summaries/* and the session counts, through
the real app over ASGI (no lifespan) on the scratch Postgres, with a fake cache and embedder."""

from collections import Counter
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import numpy as np

from ctc.config import cfg
from ctc.server.app import app

T0 = datetime.now(UTC).replace(microsecond=0) - timedelta(days=2)
OBS = [  # id, project, session, type, hours after T0
    (1, "pa", "s1", "bugfix", 1), (2, "pa", "s1", "discovery", 2), (3, "pa", "s1", "feature", 3), (4, "pb", "s2", "decision", 4),
    (5, "pa", "s1", "change", 5)]
SUMS = [(1, "pa", "s1", 3), (2, "pb", "s2", 6)]  # summary 1 and observation 3 share an instant
PROMPTS = [("s1", "pa", "r1", "fix the needle", 2.5), ("s1", "pa", "r2", "second prompt", 4.5), ("s2", "pb", "r3", "beta prompt", 5)]
# newest first: the observation leads a summary or prompt of the same instant
ALL = [("summary", 2), ("observation", 5), ("prompt", 3), ("prompt", 2), ("observation", 4), ("observation", 3), ("summary", 1),
       ("prompt", 1), ("observation", 2), ("observation", 1)]
OBS_KEYS = {"id", "project", "session_id", "prompt_number", "type", "title", "subtitle", "narrative", "facts", "concepts", "files_read",
            "files_modified", "discovery_tokens", "created_at", "deleted_at"}
SUM_KEYS = {"id", "project", "session_id", "prompt_number", "request", "investigated", "learned", "completed", "next_steps", "notes",
            "files_read", "files_edited", "created_at", "deleted_at"}
EMB = np.zeros(1024, np.float32)
EMB[0] = 1.0


class Emb:
    model_version = "fake"

    async def embed(self, texts, kind):
        return [EMB for _ in texts]


class Cache:
    def __init__(self):
        self.vecs, self.json, self.deleted = {}, {}, []

    async def get_vec(self, k):
        return self.vecs.get(k)

    async def set_vec(self, k, v, ttl):
        self.vecs[k] = v

    async def get_json(self, k):
        return self.json.get(k)

    async def set_json(self, k, v, ttl):
        self.json[k] = v

    async def delete(self, *keys):
        self.deleted += keys

    async def publish_inval(self, *a, **k):
        pass


async def seed(s):
    await s.execute("truncate observations, session_summaries, decisions, sessions, projects restart identity cascade")
    await s.executemany("insert into projects (id, name, path) values (%s, %s, %s)", [("pa", "alpha", "/a"), ("pb", "beta", "/b")])
    await s.executemany("insert into sessions (id, project_id) values (%s, %s)", [("s1", "pa"), ("s2", "pb")])
    await s.executemany(
        "insert into observations (id, project_id, session_id, type, title, content_hash, created_at, embedding)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s)",
        [(i, p, sid, t, f"Obs {i} " + ("needle" if i == 1 else "plain"), str(i), T0 + timedelta(hours=h), EMB) for i, p, sid, t, h in OBS])
    await s.executemany("insert into session_summaries (id, project_id, session_id, prompt_number, request, created_at)"
                        " values (%s, %s, %s, %s, %s, %s)", [(i, p, sid, i, f"Request {i}", T0 + timedelta(hours=h)) for i, p, sid, h in SUMS])
    await s.executemany("insert into decisions (session_id, project_id, ref, prompt, abstained, bundle, at)"
                        " values (%s, %s, %s, %s, false, '{}'::jsonb, %s)", [(a, b, c, d, T0 + timedelta(hours=h)) for a, b, c, d, h in PROMPTS])
    for tb in ("observations", "session_summaries"):  # explicit ids above: keep the sequences ahead
        await s.execute(f"select setval(pg_get_serial_sequence('{tb}', 'id'), (select max(id) from {tb}))")


def api(in_store, body):
    """await body(client, st) against the real app with st in app.state (no lifespan; local mode wants Host 127.0.0.1)."""
    async def go(s):
        await seed(s)
        app.state.st = st = SimpleNamespace(store=s, embedder=Emb(), cache=Cache(), cfg=cfg(), names={})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as c:
            return await body(c, st)
    return in_store(go)


def kinds(items):
    return [(i["item_type"], i["id"]) for i in items]


def cursor(i):
    return f"{i['created_at']},{i['item_type']},{i['id']}"


def err(r, status, code):
    assert r.status_code == status and r.json()["error"]["code"] == code, r.text


def test_feed_newest_first_and_cursor_paging(in_store):
    async def body(c, st):
        r = await c.get("/api/memories/feed", params={"limit": 200})
        assert r.status_code == 200 and kinds(r.json()) == ALL
        by = {i["item_type"]: i for i in r.json()}
        assert set(by["observation"]) - {"item_type"} == OBS_KEYS and set(by["summary"]) - {"item_type"} == SUM_KEYS
        assert set(by["prompt"]) == {"item_type", "id", "session_id", "prompt_number", "text", "created_at"}
        seen, before = [], None
        for _ in range(10):  # pages of 3 end between items of one instant (observation 3 / summary 1)
            page = (await c.get("/api/memories/feed", params={"limit": 3, **({"before": before} if before else {})})).json()
            if not page:
                break
            seen += kinds(page)
            before = cursor(page[-1])
        assert seen == ALL
        newest = (await c.get("/api/memories/feed", params={"limit": 3})).json()
        assert kinds((await c.get("/api/memories/feed", params={"after": cursor(newest[-1]), "limit": 200})).json()) == ALL[:2]
        mine = await c.get("/api/memories/feed", params={"project": "alpha", "limit": 200})
        assert kinds(mine.json()) == [k for k in ALL if k not in (("summary", 2), ("prompt", 3), ("observation", 4))]
        assert kinds((await c.get("/api/memories/feed", params={"session_id": "s2"})).json()) == [("summary", 2), ("prompt", 3), ("observation", 4)]
        assert kinds((await c.get("/api/memories/feed", params={"types": "summary,prompt"})).json()) == [k for k in ALL if k[0] != "observation"]
        assert kinds((await c.get("/api/memories/feed", params={"types": "bugfix,feature"})).json()) == [("observation", 3), ("observation", 1)]
        err(await c.get("/api/memories/feed", params={"project": "nope"}), 404, "not_found")
        err(await c.get("/api/memories/feed", params={"before": "garbage"}), 400, "bad_request")
        err(await c.get("/api/memories/feed", params={"types": "nonsense"}), 400, "bad_request")
    api(in_store, body)


def test_feed_q_is_one_ranked_page(in_store):
    async def body(c, st):
        items = (await c.get("/api/memories/feed", params={"q": "needle"})).json()
        assert (items[0]["item_type"], items[0]["id"]) == ("observation", 1)
        assert ("prompt", 1) in kinds(items) and kinds(items).index(("prompt", 1)) > 0  # prompts match by ilike and trail the ranked rows
        counts = (await c.get("/api/memories/feed/counts", params={"q": "needle"})).json()
        assert counts == dict(Counter(i["type"] if i["item_type"] == "observation" else i["item_type"] for i in items))
    api(in_store, body)


def test_feed_counts(in_store):
    async def body(c, st):
        r = await c.get("/api/memories/feed/counts")
        assert r.status_code == 200
        assert r.json() == {"bugfix": 1, "discovery": 1, "feature": 1, "decision": 1, "change": 1, "summary": 2, "prompt": 3}
        mine = (await c.get("/api/memories/feed/counts", params={"project": "alpha", "range": "7d"})).json()
        assert mine == {"bugfix": 1, "discovery": 1, "feature": 1, "change": 1, "summary": 1, "prompt": 2}
        assert (await c.get("/api/memories/feed/counts", params={"session_id": "s2"})).json() == {"decision": 1, "summary": 1, "prompt": 1}
    api(in_store, body)


def test_timeline(in_store):
    async def body(c, st):
        r = await c.get("/api/memories/timeline", params={"anchor": "3", "depth_before": 1, "depth_after": 1, "project": "alpha"})
        assert r.status_code == 200
        items = r.json()  # oldest first; observation 4 belongs to the other project
        assert kinds(items) == [("observation", 2), ("summary", 1), ("observation", 3), ("observation", 5)]
        assert [i["id"] for i in items if i["anchor"]] == [3]
        s = (await c.get("/api/memories/timeline", params={"anchor": "S2", "depth_before": 0, "depth_after": 0})).json()
        assert [(i["item_type"], i["id"], i["anchor"]) for i in s if i["anchor"]] == [("summary", 2, True)]
        err(await c.get("/api/memories/timeline", params={"anchor": "garbage"}), 400, "bad_request")
        err(await c.get("/api/memories/timeline"), 400, "bad_request")
    api(in_store, body)


def test_context(in_store):
    async def body(c, st):
        err(await c.get("/api/memories/context"), 400, "bad_request")
        err(await c.get("/api/memories/context", params={"project": "nope"}), 404, "not_found")
        r = await c.get("/api/memories/context", params={"project": "alpha"})
        assert r.status_code == 200 and list(r.json()) == ["text"]
        text = r.json()["text"]
        assert text.startswith("<ctc-memory-context>") and "[alpha] recent context" in text and "Obs 5 plain" in text and "Obs 4" not in text
        assert "ctx:local:pa" in st.cache.json  # rendered once, cached for the hook
    api(in_store, body)


def test_delete_restore_round_trip(in_store):
    async def body(c, st):
        for kind, tid, key in (("observations", 1, "observation"), ("summaries", 1, "summary")):
            r = await c.delete(f"/api/{kind}/{tid}")
            assert r.status_code == 200 and r.json() == {"ok": True}
            assert (key, tid) not in kinds((await c.get("/api/memories/feed", params={"limit": 200})).json())
            r = await c.post(f"/api/{kind}/{tid}/restore")
            row = r.json()
            assert r.status_code == 200 and row["id"] == tid and row["deleted_at"] is None
            assert set(row) - {"item_type"} == (OBS_KEYS if key == "observation" else SUM_KEYS)
            assert (key, tid) in kinds((await c.get("/api/memories/feed", params={"limit": 200})).json())
            err(await c.delete(f"/api/{kind}/999"), 404, "not_found")
            err(await c.post(f"/api/{kind}/999/restore"), 404, "not_found")
        assert st.cache.deleted.count("ctx:local:pa") == 4  # every delete and restore drops the project's index
        r = await c.get("/api/observations/2")
        assert r.status_code == 200 and r.json()["title"] == "Obs 2 plain" and set(r.json()) - {"item_type"} == OBS_KEYS
        err(await c.get("/api/observations/999"), 404, "not_found")
    api(in_store, body)


def test_sessions_counts_and_detail(in_store):
    async def body(c, st):
        r = await c.get("/api/sessions")
        assert r.status_code == 200 and {x["id"]: x["observations"] for x in r.json()} == {"s1": 4, "s2": 1}
        await c.delete("/api/observations/5")
        assert {x["id"]: x["observations"] for x in (await c.get("/api/sessions")).json()} == {"s1": 3, "s2": 1}
        d = (await c.get("/api/sessions/s1")).json()
        assert [o["id"] for o in d["observations"]] == [3, 2, 1] and [s["id"] for s in d["summaries"]] == [1]  # newest first, not deleted
        assert set(d["observations"][0]) == OBS_KEYS and set(d["summaries"][0]) == SUM_KEYS and d["observations"][0]["project"] == "alpha"
    api(in_store, body)


def test_delete_session_and_project_drop_ctx(in_store):
    async def body(c, st):
        assert (await c.delete("/api/sessions/s1")).status_code == 200
        assert st.cache.deleted == ["ctx:local:pa"]
        assert (await c.delete("/api/projects/beta")).status_code == 200
        assert "ctx:local:pb" in st.cache.deleted
        err(await c.delete("/api/sessions/s1"), 404, "not_found")
    api(in_store, body)
