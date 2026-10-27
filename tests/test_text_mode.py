"""M8-1: embedding text modes, query instructions, config knobs. No DB, no TEI (the embedder runs on a mock transport)."""

import asyncio
import json
import re
import shutil

import httpx
import pytest

from ctc import config
from ctc.config import cfg
from ctc.embedding.embedder import QUERY_INSTRUCTION, QUERY_INSTRUCTIONS, Embedder
from ctc.ingestion.indexer import build_index, texts

CAP = {"id": "u:fix", "name": "fix-tests", "description": "Fix flaky tests", "summary": "Finds and fixes flaky tests.",
       "triggers": ["fix the flaky test", "  ", "tests fail sometimes"], "body": "# Fix tests\n" + "b" * 20000}


def test_current_text_is_unchanged():
    # frozen: what the indexer produced before m8 (blank trigger dropped, doc cut at 1000 chars before the summary)
    want = ["fix-tests: Fix flaky tests Finds and fixes flaky tests.", "fix the flaky test", "tests fail sometimes"]
    assert texts(CAP) == texts(CAP, "current") == want
    assert texts({"name": "fix", "description": "d" * 2000, "triggers": None}) == ["fix: " + "d" * 995]


def test_skillret_text_cuts_the_body(monkeypatch):
    monkeypatch.setitem(cfg()["embed"], "skillret_body_chars", 8000)
    (t,) = texts(CAP, "skillret")  # one string: no summary, no triggers
    assert t == "fix-tests | Fix flaky tests | " + CAP["body"][:8000] and len(t) == len("fix-tests | Fix flaky tests | ") + 8000
    monkeypatch.setitem(cfg()["embed"], "skillret_body_chars", 100)
    assert texts(CAP, "skillret") == ["fix-tests | Fix flaky tests | " + CAP["body"][:100]]


@pytest.mark.parametrize("body", ["", None, "missing"])
def test_skillret_text_without_a_body(body):
    cap = {k: v for k, v in CAP.items() if k != "body"} | ({} if body == "missing" else {"body": body})
    assert texts(cap, "skillret") == ["fix-tests | Fix flaky tests"]


def test_default_mode_follows_config(monkeypatch):
    monkeypatch.setitem(cfg()["embed"], "text", "skillret")
    assert texts(CAP)[0].startswith("fix-tests | Fix flaky tests | # Fix tests")
    assert texts(CAP, "current")[0].startswith("fix-tests: ")  # an explicit mode wins


class FakeStore:
    """Just what build_index touches. fetch() answers the body query (the catalog has no body column)."""

    def __init__(self):
        self.catalog = {"s:a": {"id": "s:a", "name": "a", "description": "da", "summary": None, "triggers": []}}
        self.fetched, self.inserted = [], []

    async def refresh_catalog(self): ...

    async def fetch(self, sql, params=None):
        self.fetched.append(params)
        return [{"id": "s:a", "body": "B" * params[0]}]

    async def vector_keys(self):
        return set()

    async def insert_vectors(self, rows):
        self.inserted += [r[3] for r in rows]


class FakeEmbedder:
    model_version = "m"

    async def embed(self, texts, kind):
        return [[0.0]] * len(texts)


def test_build_index_fetches_bodies_only_for_skillret(monkeypatch):
    store = FakeStore()
    asyncio.run(build_index(store, FakeEmbedder()))
    assert store.inserted == ["a: da"] and store.fetched == []  # default mode: no extra query
    store = FakeStore()
    monkeypatch.setitem(cfg()["embed"], "text", "skillret")
    monkeypatch.setitem(cfg()["embed"], "skillret_body_chars", 50)
    asyncio.run(build_index(store, FakeEmbedder()))
    assert store.fetched == [(50,)] and store.inserted == ["a | da | " + "B" * 50]


def test_instruction_strings():
    assert QUERY_INSTRUCTIONS["skillret"] == "Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: "
    assert QUERY_INSTRUCTIONS["coding"] == QUERY_INSTRUCTION == (
        "Instruct: Given a coding task or question, retrieve capabilities (skills, agents, commands, workflows) that help accomplish it\nQuery: ")


@pytest.mark.parametrize("name", ["coding", "skillret"])
def test_embedder_picks_the_configured_instruction(monkeypatch, name):
    monkeypatch.setitem(cfg()["embed"], "instruction", name)
    sent = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req.read())
        return httpx.Response(200, json=[[0.0, 1.0], [1.0, 0.0]])

    async def go():
        e = Embedder("http://tei.test")
        e._client, e._loop, e.model_version = httpx.AsyncClient(transport=httpx.MockTransport(handler)), asyncio.get_running_loop(), "m"
        await e.embed(["a", "b"], "query")
        await e.embed(["a", "b"], "doc")
        await e.aclose()

    asyncio.run(go())
    assert json.loads(sent[0])["inputs"] == [QUERY_INSTRUCTIONS[name] + "a", QUERY_INSTRUCTIONS[name] + "b"]
    assert json.loads(sent[1])["inputs"] == ["a", "b"]  # docs get no prefix


def load(tmp_path, monkeypatch, edit=lambda t: t) -> dict:
    """cfg() over a copy of config/ with retrieval.yaml edited."""
    shutil.copytree(config.ROOT / "config", tmp_path / "config")
    f = tmp_path / "config" / "retrieval.yaml"
    f.write_text(edit(f.read_text()))
    monkeypatch.setattr(config, "ROOT", tmp_path)
    cfg.cache_clear()
    try:
        return cfg()
    finally:
        cfg.cache_clear()  # the next test reloads the real files


@pytest.mark.parametrize("key, pattern, bad", [
    ("embed.text", r"(embed: \{text: )\w+", r"\1sklillret"),
    ("embed.instruction", r"(instruction: )\w+", r"\1nope"),
    ("ranking.fusion", r"(fusion: )\w+", r"\1nope"),
    ("gate.kind", r'(gate: \{kind: )"?\w+"?', r"\1nope"),
])
def test_bad_knob_fails_at_load(tmp_path, monkeypatch, key, pattern, bad):
    with pytest.raises(ValueError, match=re.escape(key)):
        load(tmp_path, monkeypatch, lambda t: re.sub(pattern, bad, t, count=1))


def test_old_config_file_still_loads(tmp_path, monkeypatch):
    def old(t: str) -> str:  # a retrieval.yaml from before m8: no embed, no gate, no fusion / score_w
        t = re.sub(r"^(embed|gate):.*\n", "", t, flags=re.MULTILINE)
        return t.replace(", fusion: rrf, score_w: 0.7", "")

    c = load(tmp_path, monkeypatch, old)
    assert c["embed"] == config._DEFAULTS["embed"] and c["gate"] == config._DEFAULTS["gate"]
    assert {k: c["ranking"][k] for k in config._DEFAULTS["ranking"]} == config._DEFAULTS["ranking"] and "keyword_rrf_weight" in c["ranking"]


def test_bare_off_is_off(tmp_path, monkeypatch):  # YAML reads an unquoted `off` as False
    assert load(tmp_path, monkeypatch, lambda t: t.replace('kind: "off"', "kind: off"))["gate"]["kind"] == "off"


def test_catalog_bodies_only_in_skillret_mode(monkeypatch):
    """enrich.dedup and build_index rebuild the stored vector text from this: default fetches nothing, skillret fetches the cut body."""
    from ctc.ingestion.indexer import catalog_bodies

    class FakeStore:
        async def fetch(self, sql, args):
            self.args = args
            return [{"id": "u:fix", "body": "short"}]

    store = FakeStore()
    assert asyncio.run(catalog_bodies(store)) == {} and not hasattr(store, "args")  # current: no query at all
    monkeypatch.setitem(cfg()["embed"], "text", "skillret")
    monkeypatch.setitem(cfg()["embed"], "skillret_body_chars", 123)
    assert asyncio.run(catalog_bodies(store)) == {"u:fix": "short"} and store.args == (123,)
