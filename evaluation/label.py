"""K1 transcript labeler: typed user prompts from Claude Code transcripts, LLM-judged against the capability catalog.

Queries come from transcripts only (never from the enricher). Writes data/processed/own-eval.jsonl + own-eval-review.csv.
Usage: uv run python -m evaluation.label [--limit N] [--max N]   (--limit 0 = count candidates, no LLM)
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import time
from itertools import zip_longest
from pathlib import Path
from typing import Literal

import anthropic
import openai
from pydantic import Field, create_model

from ctc.config import ROOT, cfg
from ctc.ingestion.history import typed_prompt
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.llm.client import llm_from_env

OUT = ROOT / "data" / "processed"
SELF = "-home-aiface-dangnguyenducanh-claudethecaller"  # this repo's own sessions (incl. worktrees)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _text(row: dict) -> str:
    """The user's typed prompt, or '' for meta / tool-result / system-injected rows (filter shared with B9's import)."""
    return typed_prompt(row)[:2000]


def turns(projects: Path) -> list[dict]:
    """Deduped (by normalized text) candidate turns: {id, session_id, split, query}.

    Resumed/forked sessions copy history under a new sessionId with the same message uuid, so sessions sharing
    any uuid are one conversation (union-find, root = smallest sessionId) and the split hashes that root.
    """
    par: dict[str, str] = {}  # sessionId -> parent; roots are absent
    first: dict[str, str] = {}  # message uuid -> first sessionId seen

    def root(s: str) -> str:
        while s in par:
            s = par[s]
        return s

    seen, out = set(), []
    for f in sorted(projects.glob("**/*.jsonl")):
        if "/subagents/" in str(f) or f.relative_to(projects).parts[0].startswith(SELF):
            continue
        for line in f.open(encoding="utf-8", errors="replace"):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            sid = row.get("sessionId", f.stem)
            if u := row.get("uuid"):
                a, b = root(first.setdefault(u, sid)), root(sid)
                if a != b:
                    par[max(a, b)] = min(a, b)
            key = " ".join((t := _text(row)).lower().split())
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({"id": _sha(key)[:16], "session_id": sid, "split": 0, "query": t})
    for t in out:
        t["split"] = int(_sha(root(t["session_id"])), 16) % 2
    return out


def sample(cands: list[dict], n: int) -> list[dict]:
    """Deterministic: round-robin over sessions (hash order) within each split, test and dev interleaved."""
    rr = []
    for split in (1, 0):
        by_sess: dict[str, list[dict]] = {}
        for t in sorted((t for t in cands if t["split"] == split), key=lambda t: t["id"]):
            by_sess.setdefault(t["session_id"], []).append(t)
        rr.append([t for group in zip_longest(*(by_sess[s] for s in sorted(by_sess, key=_sha))) for t in group if t])
    return [t for pair in zip_longest(*rr) for t in pair if t][:n]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=600, help="turns to label in total (sampled)")
    ap.add_argument("--limit", type=int, default=None, help="label at most N new turns this run (0 = count only)")
    a = ap.parse_args()

    cands = turns(Path(cfg()["claude_home"]) / "projects")
    picked = sample(cands, a.max)
    print(f"candidates: {len(cands)} ({sum(t['split'] for t in cands)} test) in "
          f"{len({t['session_id'] for t in cands})} sessions; sampled {len(picked)} ({sum(t['split'] for t in picked)} test)")

    OUT.mkdir(parents=True, exist_ok=True)
    jl = OUT / "own-eval.jsonl"
    done = {json.loads(line)["id"] for line in jl.open()} if jl.exists() else set()
    todo = [t for t in picked if t["id"] not in done][: a.limit]
    print(f"already labeled: {len(done)}; labeling now: {len(todo)}")

    if todo:
        caps, _ = scan_library(default_roots(Path.cwd()))
        ids = sorted({c.id for c in caps})
        catalog = "\n".join(f"{c.id}: {c.description[:100]}" for c in sorted(caps, key=lambda c: c.id))
        # Enum ids: llama.cpp's grammar can only emit catalog ids (no silent drops); maxItems keeps it from looping.
        label = create_model("Label", cap_ids=(list[Literal[tuple(ids)]], Field(max_length=5)),
                             reason=(str, Field(max_length=300)))
        # Identical system prompt every call so llama.cpp reuses the KV cache for the ~20k-token prefix.
        system = (
            "You label which capabilities (skills, agents, slash commands, workflows) a coding assistant should use "
            "to handle a user's prompt.\n\nCatalog, one per line as `id: description`:\n"
            f"{catalog}\n\n"
            "Rules: cap_ids = ids copied exactly from the catalog that directly help with the prompt, best first, "
            "at most 5. Use an empty list when none clearly applies (chit-chat, thanks, short follow-ups, simple "
            "questions or edits any assistant handles without a capability). reason = one short sentence."
        )
        llm = llm_from_env()
        with jl.open("a", encoding="utf-8") as fh:
            for i, t in enumerate(todo, 1):
                t0 = time.perf_counter()
                try:
                    lab = llm.json(system, f"Prompt:\n{t['query']}", label)
                except (openai.OpenAIError, anthropic.AnthropicError, ValueError) as e:  # server / bad JSON: skip, a re-run retries it
                    print(f"[{i}/{len(todo)}] {t['id']} error after {time.perf_counter() - t0:.1f}s: {e}", flush=True)
                    continue
                gold = list(dict.fromkeys(lab.cap_ids))
                fh.write(json.dumps({**t, "gold": gold, "reason": lab.reason}, ensure_ascii=False) + "\n")
                fh.flush()
                print(f"[{i}/{len(todo)}] {time.perf_counter() - t0:.1f}s/call {t['id']} split={t['split']} "
                      f"gold={gold}", flush=True)

    # Append-only: rows already in the CSV may hold the owner's H1 edits, so never rewrite them.
    rev = OUT / "own-eval-review.csv"
    fresh = not rev.exists()
    have = set() if fresh else {r["id"] for r in csv.DictReader(rev.open(encoding="utf-8"))}
    rows = [r for r in map(json.loads, jl.open()) if r["split"] == 1 and r["id"] not in have] if jl.exists() else []
    new = rows[: max(0, 200 - len(have))]
    if new:
        tail_nl = fresh or rev.read_bytes().endswith(b"\n")
        with rev.open("a", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            fh.write("" if tail_nl else "\r\n")
            if fresh:
                w.writerow(["id", "query", "gold"])
            w.writerows([r["id"], r["query"], ";".join(r["gold"])] for r in new)
    print(f"review rows (test): {len(have) + len(new)} (+{len(new)} new) -> {rev}")


if __name__ == "__main__":
    main()
