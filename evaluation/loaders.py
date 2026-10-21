"""K1 benchmark loaders: SkillRet (skills, queries, qrels) and MetaTool's "no tool needed" rows (gold = none).

SkillRet protocol (dataset card): test queries are scored against the `skills` test split (6,006), not all 16k.
Usage: uv run python -m evaluation.loaders   (prints counts + one sample of each)
"""

from __future__ import annotations

import hashlib
import json
import urllib.request

from datasets import load_dataset
from datasets import logging as ds_logging

from ctc.config import ROOT
from ctc.ingestion.scanner import Capability

RAW = ROOT / "data" / "raw"
# pinned commits: the benchmark files must not move under us (SkillRet main has no v1.1 tag; v1.0 had other counts)
SKILLRET_REV = "6583d7d2ed07644d0fb8938ed8178f3a7dc42a12"
METATOOL_URL = (
    "https://raw.githubusercontent.com/HowieHwong/MetaTool/35e81bb7576826e980c80fed8f8c0a2b4a1e6fbb"
    "/dataset/tmp_dataset/Task1.json"
)


def _load(name: str, split: str):
    # cache_dir: the default ~/.cache/huggingface has root-owned files on this host
    return load_dataset("ThakiCloud/SKILLRET", name, split=split, cache_dir=str(RAW / "hf"), revision=SKILLRET_REV)


def skillret(split: str = "test") -> tuple[list[dict], list[dict], dict[str, dict[str, int]]]:
    """(skills, queries, qrels[query_id]["skillret:<skill id>"] = 1), qrels keyed by Capability.id like search hits.
    Skill rows drop `skill_md` (a duplicate of `body`)."""
    ds_logging.set_verbosity_error()  # the card's malformed `splits` YAML warns on every load
    skills = _load("skills", split).remove_columns("skill_md").to_list()
    qrels: dict[str, dict[str, int]] = {}
    for r in _load("qrels", split):
        qrels.setdefault(r["query_id"], {})[f"skillret:{r['skill_id']}"] = r["relevance"]
    return skills, _load("queries", split).to_list(), qrels


def skillret_caps(skills: list[dict]) -> list[Capability]:
    caps = []
    for s in skills:
        body = s["body"].replace("\x00", "")  # 1 test body has NUL bytes; Postgres text rejects them
        caps.append(Capability(
            id=f"skillret:{s['id']}",  # names repeat (205 dupes in test), the uuid does not
            kind="skill",
            name=s["name"],
            namespace="skillret",
            description=s["description"],
            body=body,
            path=f"skillret://{s['id']}",
            hash=hashlib.sha256(f"{s['description']}\n{body}".encode()).hexdigest(),
        ))
    return caps


def metatool() -> list[dict]:
    """MetaTool Task 1 (tool-usage awareness) rows labelled "negative": queries that need no tool at all.
    Not Task 2 subtask 3 ("reliability"): those queries do need a tool (RepoTool, SSH, ...), it was only hidden."""
    path = RAW / "metatool" / "Task1.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        urllib.request.urlretrieve(METATOOL_URL, part)
        part.rename(path)
    rows = json.loads(path.read_text(encoding="utf-8"))
    # ponytail: some negatives are plain coding asks ("write Python code for this leetcode problem"); H1 spot-checks
    return [{"id": f"metatool:{i}", "query": r["query"], "gold": []} for i, r in enumerate(rows) if r["label"] == "negative"]


if __name__ == "__main__":
    def short(row: dict) -> dict:
        return {k: (v[:120] + "…" if isinstance(v, str) and len(v) > 120 else v) for k, v in row.items()}

    skills, queries, qrels = skillret()
    caps = skillret_caps(skills)
    ids = {c.id for c in caps}
    assert len(ids) == len(caps) == len(skills)
    assert not any("\x00" in c.body for c in caps)
    assert set(qrels) == {q["id"] for q in queries}
    assert all(d in ids for rel in qrels.values() for d in rel)
    print(f"skillret test: {len(skills)} skills, {len(queries)} queries, {len(qrels)} qrels queries / "
          f"{sum(map(len, qrels.values()))} pairs")
    print("skill:", short(skills[0]))
    print("cap:", short(vars(caps[0])))
    print("query:", short(queries[0]))
    print("qrels:", queries[0]["id"], qrels[queries[0]["id"]])
    mt = metatool()
    assert len(mt) == 520 and all(r["gold"] == [] for r in mt)  # Task1: 520 positive / 520 negative
    print(f"metatool task1 negatives: {len(mt)} queries (gold = none)")
    print("metatool:", mt[0])
