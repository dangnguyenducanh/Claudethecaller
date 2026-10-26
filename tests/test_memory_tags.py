"""m7 O1: tag stripping, wider secret redaction, the prompt hook's privacy gate, and the observations / session_summaries
tables. The first three groups are DB-free; the last needs the scratch Postgres (`scratch` / `in_store` fixtures)."""

import asyncio
import time
import uuid
from types import SimpleNamespace

import numpy as np
import psycopg
import pytest

from ctc.config import cfg
from ctc.decision.bundle import Bundle
from ctc.graph import core
from ctc.ingestion.scanner import project_id
from ctc.llm.client import _redact
from ctc.memory.tags import TAG_NAMES, strip_tags
from ctc.server import hooks

# ---- strip_tags -----------------------------------------------------------------------------------------------------


def test_strip_tags_basic():
    assert strip_tags("a <private>x</private> b") == "a  b"
    assert strip_tags("<private>a<private>b</private>c</private>") == ""
    assert strip_tags("<ctc-memory-context>\n# recent context\n- S1 x\n</ctc-memory-context>") == ""
    assert strip_tags("a < b and x<y, 3 > 2") == "a < b and x<y, 3 > 2"  # `<` without a tag name is text
    assert strip_tags("keep <div>this</div> and <b>that</b>") == "keep <div>this</div> and <b>that</b>"


def test_strip_tags_every_name():
    assert len(TAG_NAMES) == 7
    for n in TAG_NAMES:
        assert strip_tags(f"before <{n}>secret</{n}> after") == "before  after", n
    assert strip_tags('x <private note="</private>">hidden</private> y') == "x  y"  # a close inside the opener's attribute is text


def test_strip_tags_unbalanced_strips_to_the_end():
    assert strip_tags("keep <private>never closed, with a secret") == "keep"
    assert strip_tags("a <private>x</private> b <private> tail") == "a  b"
    assert strip_tags("stray </private> close stays") == "stray </private> close stays"


def test_strip_tags_many_tags_linear_and_uncapped():
    text = "<private>s</private>y" * 200  # MAX_TAG_COUNT only logs: the 150th block goes too
    t = time.perf_counter()
    out = strip_tags(text)
    assert time.perf_counter() - t < 0.05
    assert out == "y" * 200
    assert strip_tags("<private " * 5000 + "x") == ""  # no quadratic rescans on unclosed openers


# ---- _redact --------------------------------------------------------------------------------------------------------

A36 = "a1B2" * 9
SECRETS = {
    "gh_pat": f"ghp_{A36}", "gh_oauth": f"gho_{A36}", "gh_user": f"ghu_{A36}", "gh_server": f"ghs_{A36}", "gh_refresh": f"ghr_{A36}",
    "github_pat": "github_pat_" + "A1b_" * 20 + "A1",
    "slack": "xoxb-1234567890-abcdefghijkl",
    "stripe": "sk_live_" + "a1B2" * 7,
    "google": "AIza" + "A1b2_" * 7,
    "aws_akia": "AKIAABCDEFGH12345678", "aws_asia": "ASIAABCDEFGH12345678",
    "aws_secret": "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "aws_session": "aws_session_token = " + "A1b2/+=x" * 14,
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "password": "DB_PASSWORD=hunter22xyz", "token": "API_TOKEN: abcd1234efgh", "secret": "CLIENT_SECRET='s3cr3tvalue99'",
    "api_key": "STRIPE_API_KEY=abcdefgh1234",
    "pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7zebra\nQ2tNZ0JFdUc=\n-----END RSA PRIVATE KEY-----",
    "pem_open": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANzebra\nnever terminated",
    "old_sk": "sk-" + "a1B2" * 5, "old_hf": "hf_" + "a1B2" * 5, "old_bearer": "Bearer abcdefghij1234", "old_url": "https://user:pw0rd@host/x",
}
SECRET_BODY = {"aws_secret": "wJalrXUtnFEMI", "aws_session": "A1b2/+=x", "password": "hunter22xyz", "token": "abcd1234efgh",
               "secret": "s3cr3tvalue99", "api_key": "abcdefgh1234", "pem": "zebra", "pem_open": "zebra", "old_url": "pw0rd",
               "jwt": "dozjgNryP4J3jVmNHl0w5N", "google": "A1b2_A1b2_", "stripe": "a1B2a1B2a1B2"}


@pytest.mark.parametrize("name", SECRETS)
def test_redact_secret(name):
    out = _redact(f"before {SECRETS[name]} after")
    assert "[REDACTED]" in out and out.startswith("before ") and (out.endswith(" after") or name == "pem_open")
    assert SECRETS[name] not in out and SECRET_BODY.get(name, SECRETS[name]) not in out, out


def test_redact_keeps_what_is_not_a_secret():
    for text in ("max_tokens=4096", "PWD=/home/me/work", "see ghp_short and sk_live_x", "AWS_SECRET_ACCESS_KEY=short"):
        assert _redact(text) == text, text


def test_redact_pem_end_line_in_the_middle_of_a_long_text():
    text = "x" * 20_000 + "\n-----BEGIN PRIVATE KEY-----\n" + "K" * 5000 + "\n-----END PRIVATE KEY-----\n" + "y" * 15_000
    t = time.perf_counter()
    out = _redact(text)
    assert time.perf_counter() - t < 1
    assert "KKKK" not in out and "PRIVATE KEY" not in out and out.startswith("x" * 100) and out.endswith("y" * 100)


# ---- _prompt --------------------------------------------------------------------------------------------------------


def _hook(monkeypatch, prompt):
    calls = {"route": [], "write": []}

    async def route(st, p, sid, cwd, user_id="local", k=None):
        calls["route"].append(p)
        return Bundle(ref="abcd1234", intent=p, abstained=False)

    async def write(st, kind, row):
        calls["write"].append((kind, row))

    async def no_graph(*a, **k):
        return None

    monkeypatch.setattr(hooks, "route", route)
    monkeypatch.setattr(hooks, "write", write)
    monkeypatch.setattr(core, "graph_for", no_graph)
    st = SimpleNamespace(cfg=cfg(), names={("local", project_id("/x")): "x"})
    asyncio.run(hooks._prompt(st, {"prompt": prompt, "session_id": "s", "cwd": "/x"}, "local"))
    return calls


def test_prompt_fully_private_is_dropped(monkeypatch):
    c = _hook(monkeypatch, "<private>secret</private>")
    assert c == {"route": [], "write": []}


def test_prompt_tags_are_stripped_before_route_and_writes(monkeypatch):
    c = _hook(monkeypatch, "fix <private>k</private> bug")
    assert c["route"] == ["fix  bug"]
    rows = dict(c["write"])
    assert rows["session"]["title"] == "fix  bug" and rows["decision"]["prompt"] == "fix  bug"
    assert "<private>" not in str(c)


def test_prompt_secrets_are_redacted_before_route_and_writes(monkeypatch):
    tok = "ghp_" + A36
    c = _hook(monkeypatch, f"use {tok}")
    rows = dict(c["write"])
    assert c["route"] == ["use [REDACTED]"] and rows["session"]["title"] == rows["decision"]["prompt"] == "use [REDACTED]"
    assert tok not in str(c)


# ---- tables (scratch Postgres) --------------------------------------------------------------------------------------

V = np.ones(1024, dtype="float32")
OBS = ("insert into observations (project_id, session_id, type, title, content_hash, embedding) values (%s, %s, %s, 't', %s, %s)")
SUM = "insert into session_summaries (project_id, session_id, prompt_number, request) values (%s, %s, %s, 'r')"


async def _session(s) -> tuple[str, str]:
    await s.ensure_project("/x/o1")
    pid, sid = project_id("/x/o1"), f"o1-{uuid.uuid4().hex[:8]}"
    await s.execute("insert into sessions (id, project_id) values (%s, %s)", (sid, pid))
    return pid, sid


def test_tables_exist_and_session_watermarks_start_at_zero(in_store):
    async def go(s):
        pid, sid = await _session(s)
        assert await s.fetchval("select to_regclass('observations') is not null and to_regclass('session_summaries') is not null")
        assert await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (sid,)) == {
            "observed_bytes": 0, "observed_prompts": 0}
        await s.execute(OBS, (pid, sid, "discovery", "h1", V))
        row = await s.fetchrow("select tsv is not null as tsv, subtitle, facts, deleted_at from observations where session_id = %s", (sid,))
        assert row == {"tsv": True, "subtitle": "", "facts": [], "deleted_at": None}
    in_store(go)


def test_observation_type_check_and_content_hash_unique(in_store):
    async def go(s):
        pid, sid = await _session(s)
        for t in ("bugfix", "feature", "refactor", "change", "discovery", "decision", "security_alert", "security_note", "sensitive"):
            await s.execute(OBS, (pid, sid, t, f"h-{t}", V))
        with pytest.raises(psycopg.errors.CheckViolation):
            await s.execute(OBS, (pid, sid, "other", "h-other", V))
        with pytest.raises(psycopg.errors.UniqueViolation):
            await s.execute(OBS, (pid, sid, "bugfix", "h-bugfix", V))
    in_store(go)


def test_summary_unique_per_prompt_number(in_store):
    async def go(s):
        pid, sid = await _session(s)
        await s.execute(SUM, (pid, sid, 1))
        await s.execute(SUM, (pid, sid, 2))
        with pytest.raises(psycopg.errors.UniqueViolation):
            await s.execute(SUM, (pid, sid, 1))
        assert await s.fetchval("select count(*) from session_summaries where session_id = %s", (sid,)) == 2
    in_store(go)


def test_schema_reapplies_and_keeps_rows(in_store):
    async def mark(s):
        pid, sid = await _session(s)
        await s.execute(OBS, (pid, sid, "change", "keep", V))
        await s.execute(f"comment on schema {s.schema} is 'stale'")  # the next open sees a different version and re-runs the DDL
        return sid

    sid = in_store(mark)
    assert in_store(lambda s: s.fetchval("select count(*) from observations where session_id = %s", (sid,))) == 1
