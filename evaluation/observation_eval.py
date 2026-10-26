"""SC-007 (m7 O8): is the right observation or summary among memory_search's first 5 results?

- Input: a jsonl of {"q": str, "expect": [id or "S<n>"]} (12 = observation 12, "S3" = summary 3), plus --project <name>.
  The owner writes the questions (H5): data/processed/memory-questions.jsonl, not created here.
- Run: observations.search(limit=5) through Store.open + cfg(), no daemon; a question hits when any expected id is in the top 5.
- Output: hit@5 k/n and the misses. Target: >= 16 of 20 (spec.md SC-007). evaluation/memory_eval.py is the separate K4/H4 eval.

uv run python evaluation/observation_eval.py data/processed/memory-questions.jsonl --project claudethecaller
uv run python evaluation/observation_eval.py --self-check
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

K, USER, ID = 5, "local", re.compile(r"S?\d+")


def parse(lines) -> list[dict]:
    """[{"q", "expect": ["12", "S3"]}]; blank lines skipped; a bad line raises ValueError naming its number."""
    rows = []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
            q, ex = r["q"], [str(x) for x in r["expect"]]
        except (ValueError, KeyError, TypeError) as e:
            raise ValueError(f'line {n}: need {{"q": text, "expect": [12, "S3"]}} ({e!r})') from e
        if not (isinstance(q, str) and q.strip() and ex and all(ID.fullmatch(x) for x in ex)):
            raise ValueError(f'line {n}: q must be text and expect a non-empty list of ids like 12 or "S3"')
        rows.append({"q": q, "expect": ex})
    return rows


def ids(res: dict) -> list[str]:
    """Result ids in search order: "12" for an observation, "S3" for a summary."""
    items = sorted(res["observations"] + res["summaries"], key=lambda i: i["rank"])
    return [str(i["id"]) if i["item_type"] == "observation" else f"S{i['id']}" for i in items]


async def run(rows: list[dict], project: str) -> None:
    from ctc.config import cfg
    from ctc.embedding.embedder import Embedder
    from ctc.memory import observations
    from ctc.storage.store import Store

    c = cfg()
    store = await Store.open(c["database_url"], pool_max=1)
    embedder = Embedder(c["embed_url"], c["timeout_s"])
    try:
        pid = await store.fetchval("select id from projects where user_id = %s and name = %s", (USER, project))
        if pid is None:
            raise SystemExit(f"no project named {project!r} for user {USER!r}")

        async def nothing(*_):  # ponytail: no Redis here, so each query embeds through TEI; search itself is the memory_search path
            return None

        st = SimpleNamespace(store=store, cfg=c, embedder=embedder, cache=SimpleNamespace(get_vec=nothing, set_vec=nothing))
        misses = []
        for r in rows:
            got = ids(await observations.search(st, USER, [pid], query=r["q"], limit=K))
            if not set(r["expect"]) & set(got):
                misses.append((r, got))
        print(f"hit@{K} {len(rows) - len(misses)}/{len(rows)}")
        for r, got in misses:
            print(f"miss: {r['q']!r} expect {r['expect']} got {got}")
    finally:
        await embedder.aclose()
        await store.close()


def self_check() -> None:
    sample = ['{"q": "why did the hook retry", "expect": [12, "S3"]}', "", '{"q": "redis key", "expect": ["7"]}']
    assert parse(sample) == [{"q": "why did the hook retry", "expect": ["12", "S3"]}, {"q": "redis key", "expect": ["7"]}]
    for bad in ('{"q": "x"}', '{"q": "x", "expect": []}', '{"q": "x", "expect": ["abc"]}', '{"q": " ", "expect": [1]}', "nope"):
        try:
            parse([bad])
        except ValueError as e:
            assert "line 1" in str(e)
        else:
            raise AssertionError(f"accepted {bad!r}")
    res = {"observations": [{"id": 12, "item_type": "observation", "rank": 1}],
           "summaries": [{"id": 3, "item_type": "summary", "rank": 0}]}
    assert ids(res) == ["S3", "12"]
    print("observation_eval self-check ok")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("questions", nargs="?", type=Path, help="jsonl of {q, expect}")
    ap.add_argument("--project", help="project name, as the dashboard shows it")
    ap.add_argument("--self-check", action="store_true", help="validate the parser on an inline sample; touches nothing")
    a = ap.parse_args()
    if a.self_check:
        return self_check()
    if not (a.questions and a.project):
        ap.error("pass a questions file and --project (or --self-check)")
    try:
        rows = parse(a.questions.read_text().splitlines())
    except (OSError, ValueError) as e:
        sys.exit(f"{a.questions}: {e}")
    asyncio.run(run(rows, a.project))


if __name__ == "__main__":
    main()
