"""Record what the running Python daemon answers today into `fixtures/py-baseline/`, so the TypeScript rewrite (spec 007) can be compared with it.

Called by hand (a person or the orchestrator):
    python -m evaluation.record_fixtures {search|graph|api|all} [--url U] [--out DIR] [--limit N] [--force] [--skillret FILE] [--own FILE]
Why it exists: T0.1 needs the daemon's own answers (search top-5 for 200 prompts, 30 graph answers, /api reply shapes) recorded once.
Later readers of the files (not code here): T2.4 graph.jsonl, T3.3 and T5.1 search files, T1.x and T7.1 api-shapes.json.

Deliberately NOT done:
- no comparison with the TypeScript port (T5.1, T2.4); no metrics (NDCG, recall), no gold labels, no latency numbers (T0.2);
- no mutating route is called, no /v1/route, /v1/bundle, /v1/hook/*, /api/decisions, /api/kpis, /api/timeline, /api/activity;
- /api values are never recorded, only their shapes (they are live and private);
- no daemon start or stop, no Postgres, Supabase or Redis connection, no .env or credential read;
- the owner's own prompts (source `own`) are written only under `<out>/local/` (git-ignored); the public manifest holds their count and sha256.
The daemon's replies are data: nothing in them is executed or followed (redirects are not followed).
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import hashlib
import json
import os
import pathlib
import random
import re
import subprocess
import sys
import urllib.parse

import httpx

ROOT = pathlib.Path(__file__).resolve().parents[1]
N_PROMPTS = 200  # the owner asked for 200 prompts in total (own + skillret)
N_OWN = 100  # the owner asked for up to 100 of them from their own transcripts; the own file has fewer today, so the rest comes from skillret
K = 5  # hits kept per prompt: the TypeScript port is compared on its top 5
SEED = 0  # chosen by judgment: any fixed value makes the sample repeatable
TIMEOUT_S = 30.0  # chosen by judgment: a search embeds and reranks, 30 s is far above a healthy call
DAEMON = "http://127.0.0.1:18310"  # where the Python daemon serves today
OUT = "fixtures/py-baseline"
PROJECT = "claudethecaller"  # the project name the graph is built under
NEUTRAL_CWD = "/nonexistent/ctc-eval"  # evaluation/retrieval_eval.py:51 NEUTRAL: a cwd with no project capabilities, so nothing is project-filtered

REMOVED = ("/api/decisions", "/api/kpis", "/api/timeline", "/api/activity", "/v1/route", "/v1/bundle")  # D7: out of scope for the port
MUTATING = {"post", "put", "patch", "delete"}
LIST_ROUTE = {"name": ("/api/projects", "name"), "cap_id": ("/api/capabilities", "id"), "mid": ("/api/memories", "id"),
              "sid": ("/api/sessions", "id"), "job_id": ("/api/jobs", "id"), "rid": ("/api/runs", "id")}
GRAPH_TOOLS = ("graph_search", "graph_explain", "graph_path", "graph_affected")
AGENT_QUESTIONS = ROOT / "agent" / "t0-1-fixtures" / "graph_questions.json"


class Failure(Exception):
    """A run-level failure with its exit code (D4)."""

    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code, self.msg = code, msg


# ---- pure helpers ------------------------------------------------------------------------------------------------
def select_prompts(skillret: list[dict], own: list[dict], n: int | None = None, n_own: int | None = None, seed: int | None = None) -> list[dict]:
    """Rows `{id, source, query}`: own first, then skillret, each part sorted by id. Rows with a blank query are dropped, then duplicate
    queries (own wins over skillret, the smaller id wins inside a source). Reads its arguments only. Raises ValueError when fewer than `n`
    unique prompts exist. `n`, `n_own`, `seed` default to the module constants at call time."""
    n, n_own, seed = N_PROMPTS if n is None else n, N_OWN if n_own is None else n_own, SEED if seed is None else seed
    seen: set[str] = set()

    def clean(rows: list[dict]) -> list[dict]:
        out = []
        for r in sorted(rows, key=lambda r: str(r["id"])):
            if r["query"].strip() and r["query"] not in seen:
                seen.add(r["query"])
                out.append(r)
        return out

    own_rows, sr_rows = clean(own), clean(skillret)
    take_own = min(n_own, len(own_rows), n)
    if n - take_own > len(sr_rows):
        raise ValueError(f"need {n} unique non-empty prompts, have {take_own + len(sr_rows)}")
    picked_own = random.Random(seed).sample(own_rows, take_own)
    picked_sr = random.Random(seed).sample(sr_rows, n - take_own)
    return [{"id": f"{src}:{r['id']}", "source": src, "query": r["query"]}
            for src, part in (("own", picked_own), ("skillret", picked_sr)) for r in sorted(part, key=lambda r: str(r["id"]))]


def split_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """(public = source skillret, local = source own); D1. Reads `rows` only, returns the same row objects."""
    return [r for r in rows if r["source"] == "skillret"], [r for r in rows if r["source"] == "own"]


def search_row(prompt: dict, reply: dict, stable: bool = True) -> dict:
    """D3 search row from a /v1/search reply: first K hit ids and the daemon's own scores. Reads its arguments only."""
    hits = reply.get("hits", [])[:K]
    return {"id": prompt["id"], "source": prompt["source"], "query": prompt["query"], "abstained": bool(reply.get("abstained")),
            "top5": [h["id"] for h in hits], "scores": [h["score"] for h in hits], "stable": stable}


def graph_row(question: dict, is_error: bool, text: str, structured: dict | None) -> dict:
    """D3 graph row: the question's id, tool and args plus the tool's answer, whole."""
    return {"id": question["id"], "tool": question["tool"], "args": question["args"], "project": PROJECT, "is_error": is_error,
            "text": text, "structured": structured}


def _merge(a: object, b: object) -> object:
    """D11 merge of two shapes: dict keys unioned (a key on one side only gets `?`), lists merged by element, scalar kinds joined with `|`."""
    if a == b:
        return a
    if isinstance(a, dict) and isinstance(b, dict):
        ka, kb = {k.rstrip("?"): k for k in a}, {k.rstrip("?"): k for k in b}
        return {k + ("?" if k not in ka or k not in kb or ka[k] != k or kb[k] != k else ""):
                _merge(a[ka[k]], b[kb[k]]) if k in ka and k in kb else a[ka[k]] if k in ka else b[kb[k]] for k in sorted({*ka, *kb})}
    if isinstance(a, list) and isinstance(b, list):
        return [_merge(a[0], b[0])] if a and b else a or b
    kinds = {k for x in (a, b) for k in (["array"] if isinstance(x, list) else ["object"] if isinstance(x, dict) else str(x).split("|"))}
    return "|".join(sorted(kinds))


def shape(value: object) -> object:
    """D11: dict -> same keys shaped; list -> [] or [merge of element shapes]; scalars -> str|bool|number|null. Reads `value` only."""
    if isinstance(value, dict):
        return {k: shape(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        merged: list = []
        for item in value:
            merged = [_merge(merged[0], shape(item))] if merged else [shape(item)]
        return merged
    return "null" if value is None else "bool" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "str"


def plan_routes(openapi: dict) -> tuple[list[str], list[dict]]:
    """D12: (sorted GET paths to record, sorted skipped entries) from the daemon's /openapi.json. Reads `openapi` only."""
    record, skipped = [], []
    for path, ops in openapi.get("paths", {}).items():
        removed = path.startswith(REMOVED)
        for method in ops:
            m = method.lower()
            if removed:
                skipped.append({"route": f"{m.upper()} {path}", "reason": "removed"})
            elif path.startswith("/v1/hook/"):
                skipped.append({"route": f"{m.upper()} {path}", "reason": "hook"})
            elif m == "get" and (path.startswith("/api/") or path == "/v1/health"):
                record.append(path)
            elif path.startswith("/api/"):
                skipped.append({"route": f"{m.upper()} {path}", "reason": "mutating"})  # judgment: any other method is never called
    return sorted(record), sorted(skipped, key=lambda s: s["route"])


def fill_path(template: str, ids: dict[str, object]) -> str | None:
    """Fill `{name}` placeholders with url-quoted ids; None when one is missing. Reads its arguments only."""
    missing = False

    def one(m: re.Match) -> str:
        nonlocal missing
        if m.group(1) not in ids:
            missing = True
            return ""
        return urllib.parse.quote(str(ids[m.group(1)]), safe="")

    out = re.sub(r"\{(\w+)\}", one, template)
    return None if missing else out


def file_sha256(path: str | os.PathLike) -> str:
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


# ---- daemon access -----------------------------------------------------------------------------------------------
def _client(url: str) -> httpx.Client:
    return httpx.Client(base_url=url, timeout=TIMEOUT_S, follow_redirects=False)


def _call(c: httpx.Client, method: str, path: str, **kw) -> httpx.Response:
    try:
        return c.request(method, path, **kw)
    except httpx.HTTPError as e:
        raise Failure(3, f"daemon unreachable or timed out: {method} {path}: {type(e).__name__}") from e


def _ok_json(r: httpx.Response, what: str) -> object:
    if r.status_code != 200:
        raise Failure(3, f"{what} returned status {r.status_code}")
    try:
        return r.json()
    except ValueError as e:
        raise Failure(3, f"{what} returned a body that is not JSON") from e


def _health(c: httpx.Client) -> dict:
    return _ok_json(_call(c, "GET", "/v1/health"), "GET /v1/health")  # type: ignore[return-value]


# ---- file writing ------------------------------------------------------------------------------------------------
def _dump(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=1) + "\n"


def _jsonl(rows: list[dict], sort: bool = True) -> str:
    rows = sorted(rows, key=lambda r: r["id"]) if sort else rows
    return "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in rows)


def _commit(files: dict[pathlib.Path, str]) -> None:
    """Write every file to `<name>.part`, then rename all; a failure removes the `.part` files and leaves older files untouched."""
    parts = []
    try:
        for p, text in files.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            part = p.with_name(p.name + ".part")
            parts.append(part)
            part.write_bytes(text.encode("utf-8"))
        for p in files:
            p.with_name(p.name + ".part").replace(p)
    finally:
        for part in parts:
            part.unlink(missing_ok=True)


def _git_sha() -> str:
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10, check=False)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _old_manifest(out: pathlib.Path) -> dict:
    path = out / "manifest.json"
    if not path.exists():
        return {}
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Failure(2, f"{path} is not readable JSON") from e
    if not isinstance(old, dict):
        raise Failure(2, f"{path} is not a JSON object")
    return old


def _manifest(out: pathlib.Path, url: str, health: dict, limit: int | None, own_keys: dict) -> dict[pathlib.Path, str]:
    path = out / "manifest.json"
    old = _old_manifest(out)
    now = datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
    new = {**old, "recorded_at": now, "daemon_url": url, "git_sha": _git_sha(), "library_version": health.get("library_version"),
           "health": health, "limited": limit, **own_keys}
    return {path: _dump(new)}


def _read_jsonl(path: pathlib.Path) -> list[dict]:
    try:
        return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    except (OSError, ValueError) as e:
        raise Failure(2, f"{path} is not readable JSON lines") from e


# ---- subcommands: each returns (files to write, stdout line) -----------------------------------------------------
def _search(c: httpx.Client, a: argparse.Namespace, out: pathlib.Path):
    if a.skillret:
        sr = _read_jsonl(pathlib.Path(a.skillret))
    else:
        from evaluation.loaders import skillret  # lazy: pulls in `datasets`

        sr = skillret("test")[1]
    own_path = pathlib.Path(a.own) if a.own else ROOT / "data" / "processed" / "own-eval.jsonl"
    own = _read_jsonl(own_path) if own_path.exists() else []
    try:
        prompts = select_prompts(sr, own)
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise Failure(2, str(e) if isinstance(e, ValueError) else f"bad prompt row: {type(e).__name__} {e}") from e
    if a.limit:
        prompts = prompts[: a.limit]
    health = _health(c)
    passes = []
    for _ in range(2):
        replies = []
        for p in prompts:
            body = {"q": p["query"], "cwd": NEUTRAL_CWD, "k": K, "explain": False}
            replies.append(_ok_json(_call(c, "POST", "/v1/search", json=body), "POST /v1/search"))
        passes.append(replies)
    rows = []
    for p, r1, r2 in zip(prompts, *passes, strict=True):
        row = search_row(p, r1)
        row["stable"] = row["top5"] == search_row(p, r2)["top5"]
        rows.append(row)
    after = _health(c)
    if after.get("library_version") != health.get("library_version"):
        raise Failure(4, "the library changed while recording")
    pub, loc = split_rows(rows)
    local_text = _jsonl(loc)
    keys = {"prompts": {"total": len(rows), "own": len(loc), "skillret": len(pub), "unstable_skillret": sorted(r["id"] for r in pub if not r["stable"]),
                        "unstable_own": sum(not r["stable"] for r in loc)},
            "local": {"file": "local/search.own.jsonl", "rows": len(loc), "sha256": hashlib.sha256(local_text.encode("utf-8")).hexdigest()}}
    files = {out / "search.public.jsonl": _jsonl(pub), out / "local" / "search.own.jsonl": local_text}
    return files, keys, health, f"search: {len(rows)} prompts ({len(loc)} own, {len(pub)} skillret)"


async def _graph_calls(url: str, questions: list[dict]) -> list[dict]:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    rows = []
    async with streamable_http_client(url.rstrip("/") + "/mcp/") as (read, write), ClientSession(read, write) as session:
        await asyncio.wait_for(session.initialize(), TIMEOUT_S)
        for q in questions:
            res = await asyncio.wait_for(session.call_tool(q["tool"], {**q["args"], "project": PROJECT}), TIMEOUT_S)
            text = "".join(getattr(part, "text", "") for part in res.content)
            rows.append(graph_row(q, bool(res.is_error), text, res.structured_content))
    return rows


def _graph(c: httpx.Client, a: argparse.Namespace, out: pathlib.Path):
    qfile = next((p for p in (out / "graph-questions.json", ROOT / OUT / "graph-questions.json", AGENT_QUESTIONS) if p.exists()), None)
    if qfile is None:
        raise Failure(2, "graph-questions.json not found")
    try:
        questions = json.loads(qfile.read_text(encoding="utf-8"))
        use = questions[: a.limit] if a.limit else questions
        for q in use:
            if q["tool"] not in GRAPH_TOOLS:
                raise Failure(2, f"question {q['id']}: tool {q['tool']} is not a read-only graph tool")
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise Failure(2, f"{qfile} is not a list of graph questions") from e
    health = _health(c)
    try:
        rows = asyncio.run(_graph_calls(str(c.base_url), use))
    except Exception as e:  # connect, timeout and protocol errors all mean the daemon is unusable
        while isinstance(e, BaseExceptionGroup):  # the MCP task group wraps the real error
            e = e.exceptions[0]
        if isinstance(e, Failure):
            raise e  # noqa: TRY201 - the unwrapped Failure, not the group
        raise Failure(3, f"graph call failed: {type(e).__name__}") from e
    if _health(c).get("library_version") != health.get("library_version"):
        raise Failure(4, "the library changed while recording")
    files = {out / "graph.jsonl": _jsonl(rows, sort=False)}
    qpath = out / "graph-questions.json"
    if not qpath.exists():
        files[qpath] = qfile.read_bytes().decode("utf-8")
    keys = {"graph": {"questions_sha256": file_sha256(qfile), "rows": len(rows), "errors": sum(r["is_error"] for r in rows)}}
    return files, keys, health, f"graph: {len(rows)} answers ({keys['graph']['errors']} errors)"


def _api(c: httpx.Client, a: argparse.Namespace, out: pathlib.Path):
    health = _health(c)
    record, skipped = plan_routes(_ok_json(_call(c, "GET", "/openapi.json"), "GET /openapi.json"))  # type: ignore[arg-type]
    if a.limit:
        record = record[: a.limit]
    cache: dict[str, httpx.Response] = {}

    def get(path: str, query: dict | None = None) -> httpx.Response:
        key = path + json.dumps(query, sort_keys=True)
        if key not in cache:
            cache[key] = _call(c, "GET", path, params=query)
        return cache[key]

    def rows_of(path: str) -> list:
        r = get(path)
        data = r.json() if r.status_code == 200 else None
        return data if isinstance(data, list) else []

    def ids_for(template: str) -> dict[str, object]:
        ids: dict[str, object] = {}
        for p in re.findall(r"\{(\w+)\}", template):
            if p == "sid" and "/steps/" in template:
                run = rows_of("/api/runs")[:1]
                detail = get(f"/api/runs/{urllib.parse.quote(str(run[0]['id']), safe='')}") if run else None
                steps = detail.json().get("steps") if detail is not None and detail.status_code == 200 else None
                if steps:
                    ids[p] = steps[0]["id"]
            elif p in LIST_ROUTE:
                first = rows_of(LIST_ROUTE[p][0])[:1]
                if first and LIST_ROUTE[p][1] in first[0]:
                    ids[p] = first[0][LIST_ROUTE[p][1]]
        return ids

    routes, nosample = [], []
    for template in record:
        query = None
        if template == "/api/runs/compare":
            runs = rows_of("/api/runs")
            query = {"a": runs[0]["id"], "b": runs[1]["id"]} if len(runs) >= 2 else None
            path = template if query else None
        else:
            path = fill_path(template, ids_for(template))
        if path is None:
            nosample.append({"route": f"GET {template}", "reason": "no-sample"})
            continue
        r = get(path, query)
        try:
            body = shape(r.json())
        except ValueError:
            body = "str"  # judgment: a reply that is not JSON is recorded as plain text
        entry = {"route": f"GET {template}", "path": path, "status": r.status_code, "shape": body}
        routes.append({**entry, "query": query} if query else entry)
    if _health(c).get("library_version") != health.get("library_version"):
        raise Failure(4, "the library changed while recording")
    skipped = sorted([*skipped, *nosample], key=lambda s: s["route"])
    now = datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
    files = {out / "api-shapes.json": _dump({"recorded_at": now, "routes": routes, "skipped": skipped})}
    return files, {"api": {"recorded": len(routes), "skipped": len(skipped)}}, health, f"api: {len(routes)} routes, {len(skipped)} skipped"


TARGETS = {"search": ("search.public.jsonl", "local/search.own.jsonl"), "graph": ("graph.jsonl",), "api": ("api-shapes.json",)}
RUN = {"search": _search, "graph": _graph, "api": _api}


# ---- main --------------------------------------------------------------------------------------------------------
class _Parser(argparse.ArgumentParser):
    def error(self, message: str):
        raise Failure(2, message)


def _parser() -> argparse.ArgumentParser:
    p = _Parser(prog="record_fixtures", add_help=True)
    p.add_argument("cmd", choices=["search", "graph", "api", "all"])
    p.add_argument("--url")
    p.add_argument("--out")
    p.add_argument("--limit", type=int)
    p.add_argument("--force", action="store_true")
    p.add_argument("--skillret")
    p.add_argument("--own")
    return p


def main(argv: list[str] | None = None) -> int:
    """Exit codes (D4): 0 ok, 2 usage, 3 daemon unreachable or a bad status, 4 library changed, 5 target exists without --force."""
    try:
        return _main(_parser().parse_args(sys.argv[1:] if argv is None else argv))
    except Failure as f:
        print(f"error: {f.msg}", file=sys.stderr)
        return f.code
    except SystemExit as e:  # argparse --help
        return int(e.code or 0)


def _main(a: argparse.Namespace) -> int:
    if a.limit is not None and a.limit < 1:
        raise Failure(2, "--limit must be at least 1")
    url, out = (a.url or DAEMON).rstrip("/"), pathlib.Path(a.out or OUT)
    try:
        out.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise Failure(2, f"--out is not creatable: {e.strerror}") from e
    cmds = ["search", "graph", "api"] if a.cmd == "all" else [a.cmd]
    _old_manifest(out)
    if not a.force:
        for cmd in cmds:
            for t in TARGETS[cmd]:
                if (out / t).exists():
                    raise Failure(5, f"{out / t} exists; pass --force to overwrite")
    with _client(url) as c:
        for cmd in cmds:
            try:
                files, keys, health, line = RUN[cmd](c, a, out)
            except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
                raise Failure(3, f"{cmd}: unexpected daemon reply ({type(e).__name__})") from e
            _commit({**files, **_manifest(out, url, health, a.limit, keys)})
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
