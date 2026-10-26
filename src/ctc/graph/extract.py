"""Background Claude pass over the project docs (m6 G4, design.md 5.3, contracts/context-mode.md): job kind `graph_extract`.

Each changed `#`-heading section of a context source goes to one `claude -p --model haiku` call (no tools, one turn, every
hook off, cwd under graph_extract.dir) with the mode file's prompts and the parser's nodes of that file; the XML reply
becomes `claude` nodes (decision, constraint, requirement) and INFERRED edges. graph_sources `extract:<file>#<n>` holds
each chunk's version (sha of the chunk + sha of the mode file) and its parsed reply, so unchanged text never costs a call.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import yaml

from ctc.config import ROOT
from ctc.graph import core, db, parse
from ctc.ingestion.scanner import project_id
from ctc.runner import proc
from ctc.runner.engine import usage_tokens

log = logging.getLogger(__name__)

MODE = ROOT / "config" / "context-mode.yaml"
SOURCE = re.compile(r"(specs|\.scratch)/.+\.md|PLAN\.md|\.claude/prds/[^/]+\.md|CLAUDE\.md")  # context sources (fullmatch)
HEAD = re.compile(r"#{1,6} ")
QUOTA = "extract:quota"  # graph_sources row: version = the usage limit's reset time
ROWS_SQL = "select source, version, info from graph_sources where user_id = %s and project_id = %s and starts_with(source, %s)"
DEL_ROWS_SQL = ("delete from graph_sources where user_id = %s and project_id = %s and starts_with(source, %s)"
                " and source <> all(%s::text[])")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:16]


def load_mode() -> tuple[dict, str]:
    raw = MODE.read_bytes()
    return yaml.safe_load(raw), _sha(raw)


def prose(file: str) -> bool:
    """tasks.md is fully covered by the parser (ids, stories, paths), so the Claude pass skips it."""
    return not file.endswith("tasks.md")


def sources(repo: Path) -> list[str]:
    """Every context source of repo the Claude pass reads, repo-relative (the files SOURCE matches, minus tasks.md)."""
    paths = [*repo.glob("specs/**/*.md"), *repo.glob(".scratch/**/*.md"), *repo.glob(".claude/prds/*.md"),
             repo / "PLAN.md", repo / "CLAUDE.md"]
    return sorted(f for p in paths if p.is_file() and prose(f := p.relative_to(repo).as_posix()))


def chunks(text: str, max_chars: int) -> list[tuple[int, str]]:
    """(1-based start line, text): consecutive `#`-heading sections packed up to max_chars (one claude -p call each);
    a longer section is cut at its last blank line that fits, else at a line end (never inside a line)."""
    # ponytail: a "#" line inside a ``` fence starts a section too (same corner as parse._section)
    lines, spans = text.splitlines(), []
    heads = [i for i, ln in enumerate(lines) if HEAD.match(ln)]
    for a, b in zip([0, *heads], [*heads, len(lines)]):
        while a < b:
            if not lines[a].strip():
                a += 1
                continue
            end, size, cut = a, 0, 0
            while end < b and (end == a or size + len(lines[end]) < max_chars):
                size += len(lines[end]) + 1
                end += 1
                if end < b and not lines[end].strip():
                    cut = end
            if end < b and cut:
                end = cut
            spans.append((a, end))
            a = end
    packed: list[tuple[int, int]] = []
    for a, end in spans:
        if packed and len("\n".join(lines[packed[-1][0]:end]).rstrip()) <= max_chars:
            packed[-1] = (packed[-1][0], end)
        else:
            packed.append((a, end))
    return [(a + 1, "\n".join(lines[a:end]).rstrip()) for a, end in packed]


def prompt(mode: dict, known: dict[str, str], chunk: tuple[int, str]) -> str:
    """Every mode prompt part, the parser's nodes of this file (id: label), then the chunk with its file line numbers."""
    start, text = chunk
    kn = "\n".join(f"- {i}: {label[:100]}" for i, label in known.items()) or "(none)"
    numbered = "\n".join(f"{start + k}: {ln}" for k, ln in enumerate(text.splitlines()))
    return "\n\n".join([*(p.strip() for p in mode["prompts"].values()), f"Known nodes in this file:\n{kn}",
                        f"Section (line number: text):\n{numbered}"])


def parse_xml(out: str, known_ids: set[str], file: str, mode: dict | None = None) -> tuple[list[dict], list[dict]] | None:
    """Claude's reply -> (nodes `ctx:<file>:x-<slug>`, INFERRED edges), origin claude. Types and relations outside the mode,
    and edges with an end that is neither known nor new, are dropped; `<skip/>` -> ([], []); unparsable -> None."""
    mode = mode or load_mode()[0]
    out = re.sub(r"<(?![a-zA-Z/!?])", "&lt;", re.sub(r"&(?![a-zA-Z]+;|#\d+;)", "&amp;", out))  # "p95 < 150 ms & up"
    try:
        root = ET.fromstring(f"<r>{out}</r>")
    except ET.ParseError as e:
        log.warning("graph_extract: unparsable reply for %s: %s", file, e)
        return None
    nodes: dict[str, dict] = {}
    slugs: dict[str, str] = {}
    for el in root.iter("node"):
        title, text, line = (el.findtext("title") or "").strip(), (el.findtext("text") or "").strip(), el.get("line") or ""
        if el.get("type") not in mode["node_types"] or not title:
            continue
        base = re.sub(r"[^a-z0-9]+", "-", (el.get("slug") or title).lower()).strip("-")[:60] or "node"
        nid, k = f"ctx:{file}:x-{base}", 2
        while nid in nodes:
            nid, k = f"ctx:{file}:x-{base}-{k}", k + 1
        slugs.setdefault(el.get("slug") or base, nid)
        nodes[nid] = {"id": nid, "kind": "context", "type": el.get("type"), "label": title[:200], "text": text[:2000],
                      "source_file": file, "source_line": int(line) if line.isdigit() else None, "origin": "claude", "meta": {}}
    ids = set(known_ids) | set(nodes)
    edges: dict[tuple, dict] = {}
    for el in root.iter("edge"):
        a, b, rel = slugs.get(el.get("from") or "", el.get("from")), slugs.get(el.get("to") or "", el.get("to")), el.get("relation")
        if rel in mode["relations"] and a in ids and b in ids and a != b:
            edges[(a, b, rel)] = {"src": a, "dst": b, "relation": rel, "confidence": "INFERRED", "score": 1.0, "origin": "claude"}
    return list(nodes.values()), list(edges.values())


def argv(model: str = "haiku") -> list[str]:
    """claude -p for one chunk: no tools, one turn, every hook off (research.md R3/R4)."""
    a, _ = proc.agent_argv({"model": model, "max_turns": 1, "allowed_tools": []}, {}, None)
    return [*a, "--settings", json.dumps({"disableAllHooks": True})]


async def _call(argv: list[str], prompt: str, log_path: str, timeout_s: float = 120) -> dict:
    """One claude -p run with cwd = the extract dir (log_path's folder); tests replace this."""
    return await proc.run_agent(argv, prompt, str(Path(log_path).parent), log_path, timeout_s)


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `graph_extract`, payload {cwd, files?: [repo-relative]} (no files = every context source).
    Returns {files, chunks, sent, skipped, remaining, failed, tokens, quota_until} or {error}."""
    if st.cfg["mode"] == "shared":  # the extractor spends the owner's own claude.ai login: local mode only
        return {"error": "graph_extract runs in local mode only"}
    gc, repo = st.cfg["graph_extract"], Path(payload["cwd"])
    u, p = "local", project_id(repo)
    res = {"files": 0, "chunks": 0, "sent": 0, "skipped": 0, "remaining": 0, "failed": 0, "tokens": {}, "quota_until": None}
    q = await db.get_source(st.store, u, p, QUOTA)
    if q and q["version"] and datetime.fromisoformat(q["version"]).astimezone() > datetime.now().astimezone():
        return res | {"quota_until": q["version"]}  # paused until the usage limit resets
    pre = await proc.preflight()
    if not pre["ok"]:
        return {"error": pre["error"]}
    mode, msha = load_mode()
    # ponytail: a deleted doc keeps its claude nodes until a job names it in `files`; sweep origin claude by file if that bites
    files = [f for f in payload.get("files") or sources(repo) if prose(f)]
    pnodes, _ = parse.parse_repo(repo, files)
    wd = Path(gc["dir"]).expanduser()
    wd.mkdir(parents=True, exist_ok=True)
    log_path = wd / "last.jsonl"
    log_path.write_bytes(b"")  # this run's stream-json lines; ponytail: earlier runs' logs are dropped
    cmd, stop, replaced = argv(mode["model"]), False, False
    res["files"] = len(files)
    for fi, file in enumerate(files):
        path = repo / file
        cs = chunks(path.read_text(encoding="utf-8"), mode["max_chunk_chars"]) if path.is_file() else []
        keys = [f"extract:{file}#{n}" for n in range(len(cs))]
        vers = [_sha(t.encode()) + msha for _, t in cs]
        rows = {r["source"]: r for r in await st.store.fetch(ROWS_SQL, (u, p, f"extract:{file}#"))}
        res["chunks"] += len(cs)
        if set(rows) == set(keys) and all(rows[k]["version"] == v for k, v in zip(keys, vers)):
            res["skipped"] += len(cs)
            continue
        cached = {r["version"]: r["info"] for r in rows.values()}  # by version: a section that only moved costs nothing
        known = {n["id"]: n["label"] for n in pnodes if n["source_file"] == file}
        got = []
        for (line, text), key, v in zip(cs, keys, vers):
            if v in cached:
                res["skipped"] += 1
                info = cached[v]
            # ponytail: at most max_chunks_per_run calls per job; the rest waits for the next save or `ctc graph extract`
            elif stop or res["sent"] >= gc["max_chunks_per_run"]:
                res["remaining"] += 1
                continue
            else:
                r = await _call(cmd, prompt(mode, known, (line, text)), str(log_path), gc["timeout_s"])
                res["sent"] += 1
                tok = usage_tokens(r.get("usage"))
                for k, n in tok.items():
                    res["tokens"][k] = res["tokens"].get(k, 0) + n
                if r["status"] == "quota":  # no retry: later chunks wait, the next jobs pause until the reset
                    stop, res["quota_until"] = True, r.get("resets_at")
                    res["remaining"] += 1
                    continue
                if r["status"] != "done":  # not cached: the next run sends it again
                    res["failed"] += 1
                    log.warning("graph_extract: %s line %d: %s %s", file, line, r["status"], (r.get("error") or "")[:300])
                    continue
                parsed = parse_xml((r.get("output") or {}).get("result") or "", set(known), file, mode)
                # an unparsable reply is cached as empty too: it is not paid for again until the chunk or the mode changes
                info = {"nodes": parsed[0], "edges": parsed[1]} if parsed else {"nodes": [], "edges": [], "error": "unparsable"}
                info["tokens"] = tok
                for n in info["nodes"]:
                    n["source_line"] = n["source_line"] or line
            if key not in rows or rows[key]["version"] != v:
                await db.set_source(st.store, u, p, key, v, info)
            got.append(info)
        await st.store.execute(DEL_ROWS_SQL, (u, p, f"extract:{file}#", keys))  # sections gone from the file
        nodes = {n["id"]: n for info in reversed(got) for n in info["nodes"]}  # a repeated id: the first section's wins
        edges = {(e["src"], e["dst"], e["relation"]): e for info in got for e in info["edges"]}
        await db.replace_origin(st.store, u, p, "claude", list(nodes.values()), list(edges.values()), files=[file])
        replaced = True
        await progress((fi + 1) / len(files))
    if stop and res["quota_until"]:
        await db.set_source(st.store, u, p, QUOTA, res["quota_until"])
    if replaced:
        core.invalidate(st, u, p)
    log.info("graph_extract %s: %s", repo, res)  # token totals per pass (FR-010)
    return res
