"""G7 (design.md §8, research.md R6): does the prompt line point at files an n8n-parity ticket really changed?

- Truth: non-test source files changed by commits whose subject ends `(n8n parity NN)` (git log --all) that exist in
  the coding graph; a ticket left with none is dropped and listed.
- Prompt: the ticket's title (`# NN — slug-words`, dashes -> spaces). Dev = 01-08 (tunes graph_push.floor), test = 09-16
  (report only). Negatives: 200 MetaTool no-tool prompts (seed 0), half dev / half test.
- Graph: built in its own schema `ctc_eval` on the scratch DB with commit links off (the dev build in `ctc` stays intact).
- full = every link; SC-001..SC-003 judge it. strict = the same graph with parser bridge links ignored in RAM: tickets
  ("Touches:") and tasks name their files, so parser EXTRACTED links can point straight at truth; informative, no bar.

uv run python -m evaluation.graph_eval [--write-floor] [--daemon]
--daemon adds curl p95 of 50 prompt + 50 pre hooks on the running daemon socket; only once m6 is deployed there (it
writes session/decision rows to the daemon's DB).
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import os
import random
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import numpy as np

from ctc.config import ROOT, cfg
from ctc.embedding.embedder import Embedder
from ctc.graph import core, push
from ctc.graph.build import BRIDGE, build
from ctc.ingestion.scanner import project_id
from ctc.storage.store import Store
from evaluation.loaders import metatool

SCHEMA, FEATURE, CONFIG = "ctc_eval", ".scratch/n8n-parity", ROOT / "config" / "retrieval.yaml"
DEV, TEST = [f"{i:02d}" for i in range(1, 9)], [f"{i:02d}" for i in range(9, 17)]
FLOORS = [round(0.30 + 0.05 * i, 2) for i in range(9)]  # 0.30 ... 0.70
BAR = {"recall": 0.8, "ft": 0.10, "prompt_ms": 150, "note_ms": 50}  # spec.md SC-001..SC-003
N_NEG, TEI_BATCH = 200, 32
POINTER = re.compile(r"(?:→ |, )(\S+?):(?:\d+|None) ")  # push.prompt_line: "→ <file>:<line> <label>, <file>:<line> …"


def truth(repo: Path, tag_re: str, code_files: set[str]) -> dict[str, set[str]]:
    """{ticket: non-test files in code_files changed by its tagged commits}, merges and the stash left out; empty sets dropped."""
    log = subprocess.run(["git", "-C", str(repo), "log", "--exclude=refs/stash", "--all", "--no-merges", "--name-only",
                          "--format=%x00%s"], capture_output=True, text=True, check=True).stdout
    out: dict[str, set[str]] = {}
    for chunk in log.split("\0")[1:]:
        subject, *files = chunk.split("\n")
        if m := re.search(tag_re, subject):
            out.setdefault(m[1], set()).update(
                f for f in files if f in code_files and not f.startswith(("tests/", "specs/", ".scratch/"))
                and not f.rsplit("/", 1)[-1].startswith("test_"))
    return {t: fs for t, fs in sorted(out.items()) if fs}


def hit(line: str, files: set[str]) -> bool:
    return bool(files & set(POINTER.findall(line)[:3]))


def recall_at3(lines: dict[str, str], truth: dict[str, set[str]]) -> float:
    """Share of truth tickets whose line names a truth file among its first 3 pointers; no line = a miss."""
    return sum(hit(lines.get(t, ""), fs) for t, fs in truth.items()) / len(truth) if truth else 0.0


def score(rows: list[tuple[set[str] | None, dict[float, str]]], floor: float) -> tuple[float, float]:
    """rows = (truth files, or None for a negative; {floor: line}) -> (Recall@3, share of negatives given a line)."""
    pos = {i: fs for i, (fs, _) in enumerate(rows) if fs is not None}
    neg = [bool(lines[floor]) for fs, lines in rows if fs is None]
    return recall_at3({i: rows[i][1][floor] for i in pos}, pos), (sum(neg) / len(neg) if neg else 0.0)


def tune(floors: list[float], dev_rows: list) -> float:
    """Floor with the best dev Recall@3 among those with false-trigger <= 10%; ties -> the higher floor; none -> the highest."""
    ok = [(r, f) for f in floors for r, ft in [score(dev_rows, f)] if ft <= BAR["ft"]]
    return max(ok)[1] if ok else max(floors)


def write_floor(floor: float, path: Path = CONFIG) -> None:
    """graph_push.floor only; the trailing comment keeps its column."""
    v = str(floor)

    def put(m: re.Match) -> str:
        return m[1] + v + (" " * max(1, len(m[2]) + len(m[3]) - len(v)) if m[3] else "")
    text, n = re.subn(r"(^graph_push:.*\n(?:[ \t]+.*\n)*?[ \t]+floor:[ \t]*)([^\s#]+)([ \t]*)", put, path.read_text(),
                      count=1, flags=re.MULTILINE)
    assert n == 1, f"graph_push.floor not in {path}"
    path.write_text(text)
    cfg.cache_clear()


def prompts(issues: Path) -> dict[str, str]:
    out = {}
    for p in sorted(issues.glob("[0-9][0-9]-*.md")):
        if m := re.match(r"# (\d{2}) — (.+)", p.read_text().splitlines()[0]):
            out[m[1]] = m[2].strip().replace("-", " ")
    return out


def p95(ms: list[float]) -> float:
    return float(np.percentile(ms, 95)) if ms else float("nan")


def timed(fn, *args) -> float:
    t = time.perf_counter()
    fn(*args)
    return (time.perf_counter() - t) * 1000


def curl_ms(route: str, bodies: list[dict]) -> list[float]:
    """Wall time of the installed hook's curl over the daemon socket (-m 2 here, so a slow answer is measured, not cut)."""
    out = []
    for b in bodies:
        t = time.perf_counter()
        subprocess.run(["curl", "-s", "-m", "2", "--unix-socket", cfg()["socket"], "--data-binary", "@-",
                        f"http://ctc/v1/hook/{route}"], input=json.dumps(b), capture_output=True, text=True, check=False)
        out.append((time.perf_counter() - t) * 1000)
    return out


def verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


async def run(write: bool, daemon: bool) -> None:
    c, repo, u = cfg(), ROOT, "local"
    p = project_id(repo)
    store = await Store.open(c["database_url"], SCHEMA)
    embedder = Embedder(c["embed_url"], c["batch_timeout_s"])
    try:
        t = time.perf_counter()
        res = await build(store, embedder, repo, commits=False)
        print(f"build in schema {SCHEMA}, commit links off ({time.perf_counter() - t:.0f} s): {json.dumps(res)}")
        g = await core.load(store, u, p)
        drop = {(r["src"], r["dst"], r["relation"]) for r in await store.fetch(
            f"select src, dst, relation from graph_edges where user_id = %s and project_id = %s and origin = 'parser'"
            f" and {BRIDGE}", (u, p))}
        # ponytail: a by-meaning link equal to a parser link is stored once, as parser (build._taken), so strict loses it too
        strict = dataclasses.replace(g, out={s: [e for e in es if (s, e[0], e[1]) not in drop] for s, es in g.out.items()},
                                     inc={d: [e for e in es if (e[0], d, e[1]) not in drop] for d, es in g.inc.items()})
        code = {n["source_file"] for n in g.nodes.values() if n["kind"] == "coding" and n["source_file"]}
        print(f"graph: {len(g.nodes)} nodes, {len(g.ids)} vectors, {len(code)} code files; strict ignores {len(drop)} parser bridge links")

        titles = prompts(repo / FEATURE / "issues")
        tr = truth(repo, c["graph_links"]["commit_tags"][FEATURE], code)
        dev, test = [t for t in DEV if t in tr], [t for t in TEST if t in tr]
        for t in sorted(set(titles) - {*dev, *test}):
            why = "outside dev 01-08 / test 09-16" if t not in DEV + TEST else "no tagged commit with a non-test file in the coding graph"
            print(f"excluded: ticket {t} ({why})")
        try:
            neg = [r["query"] for r in random.Random(0).sample(metatool(), N_NEG)]
        except (OSError, ValueError) as e:  # download failed: score without negatives, never fake them
            print(f"MetaTool negatives unavailable ({type(e).__name__}: {e}); false-trigger not measured")
            neg = []
        half = len(neg) // 2
        texts = [titles[t] for t in dev + test] + neg
        vecs = [v for i in range(0, len(texts), TEI_BATCH) for v in await embedder.embed(texts[i:i + TEI_BATCH], "query")]
        qv = dict(zip(dev + test, vecs))
        nv = vecs[len(dev) + len(test):]

        def lines(graph, v) -> dict[float, str]:
            return {f: push.prompt_line(graph, v, {**c, "graph_push": {**c["graph_push"], "floor": f}}) for f in FLOORS}

        rows = {}
        for name, graph in (("full", g), ("strict", strict)):
            rows[name] = {"dev": [(tr[t], lines(graph, qv[t])) for t in dev] + [(None, lines(graph, v)) for v in nv[:half]],
                          "test": [(tr[t], lines(graph, qv[t])) for t in test] + [(None, lines(graph, v)) for v in nv[half:]]}
        print(f"\ndev sweep ({len(dev)} tickets, {half} negatives)   floor  R@3 full  FT full  | R@3 strict  FT strict")
        for f in FLOORS:
            (r, ft), (rs, fts) = score(rows["full"]["dev"], f), score(rows["strict"]["dev"], f)
            print(f"{'':42}{f:.2f}  {r:8.3f}  {ft:7.1%}  | {rs:10.3f}  {fts:9.1%}")
        floor = tune(FLOORS, rows["full"]["dev"])
        print(f"chosen floor (dev, full): {floor:.2f}  (config now {c['graph_push']['floor']})")

        print(f"\nper ticket at floor {floor:.2f} (full / strict; pointers = full line's first 3)")
        for i, t in enumerate(dev + test):
            split, k = ("dev", i) if t in dev else ("test", i - len(dev))
            lf, ls = rows["full"][split][k][1][floor], rows["strict"][split][k][1][floor]
            print(f"  {t} {split:4} {'HIT ' if hit(lf, tr[t]) else 'miss'} / {'HIT ' if hit(ls, tr[t]) else 'miss'}"
                  f"  {titles[t]!r} truth {len(tr[t])} → {', '.join(POINTER.findall(lf)[:3]) or '(no line)'}")

        cf = {**c, "graph_push": {**c["graph_push"], "floor": floor}}
        pm = [timed(push.prompt_line, g, v, cf) for v in vecs]
        nm = [timed(push.file_note, g, f, cf) for f in sorted(code)]
        (dr, dft), (r, ft) = score(rows["full"]["dev"], floor), score(rows["full"]["test"], floor)
        (sdr, sdft), (sr, sft) = score(rows["strict"]["dev"], floor), score(rows["strict"]["test"], floor)
        print(f"\nfull   dev  R@3 {dr:.3f}  FT {dft:.1%}   |  test R@3 {r:.3f}  FT {ft:.1%}")
        print(f"strict dev  R@3 {sdr:.3f}  FT {sdft:.1%}   |  test R@3 {sr:.3f}  FT {sft:.1%}   (informative, no bar)")
        print(f"SC-001 test Recall@3 (full) {r:.3f} over {len(test)} tickets, bar >= {BAR['recall']}: {verdict(r >= BAR['recall'])}")
        print(f"SC-002 test false-trigger {ft:.1%} over {len(neg) - half} MetaTool negatives, bar <= {BAR['ft']:.0%}: "
              + (verdict(ft <= BAR["ft"]) if neg else "NOT MEASURED (no negatives)"))
        print(f"SC-003 in-process, graph loaded: push.prompt_line p95 {p95(pm):.2f} ms over {len(pm)} prompts, bar <= "
              f"{BAR['prompt_ms']} ms: {verdict(p95(pm) <= BAR['prompt_ms'])}; push.file_note p95 {p95(nm):.2f} ms over "
              f"{len(nm)} files, bar <= {BAR['note_ms']} ms: {verdict(p95(nm) <= BAR['note_ms'])}")
        if daemon:
            sid, ps = f"graph-eval-{uuid.uuid4().hex[:8]}", (texts * 50)[:50]
            hp = curl_ms("prompt", [{"session_id": sid, "cwd": str(repo), "prompt": q} for q in ps])
            hn = curl_ms("pre", [{"session_id": sid, "cwd": str(repo), "tool_name": "Read", "tool_input": {"file_path": str(repo / f)}}
                                 for f in (sorted(code) * 50)[:50]])
            print(f"SC-003 daemon curl: prompt hook p95 {p95(hp):.1f} ms, bar <= {BAR['prompt_ms']} ms: "
                  f"{verdict(p95(hp) <= BAR['prompt_ms'])}; pre hook p95 {p95(hn):.1f} ms, bar <= {BAR['note_ms']} ms: "
                  f"{verdict(p95(hn) <= BAR['note_ms'])}")
        if write:
            write_floor(floor)
            print(f"wrote graph_push.floor = {floor} to {CONFIG.relative_to(ROOT)}")
    finally:
        await store.close()
        await embedder.aclose()


if __name__ == "__main__":
    dsn = os.environ.get("CTC_DATABASE_URL", "")  # read before cfg() loads .env, whose URL is Supabase
    if not dsn or "supabase" in dsn:
        sys.exit("graph_eval needs the scratch Postgres: export CTC_DATABASE_URL (not Supabase)")
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-floor", action="store_true", help="write the dev-tuned floor to config/retrieval.yaml graph_push.floor")
    ap.add_argument("--daemon", action="store_true", help="also time 50 prompt + 50 pre hooks with curl on the daemon socket")
    a = ap.parse_args()
    asyncio.run(run(a.write_floor, a.daemon))
