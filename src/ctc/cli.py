"""`ctc`: command-line front end for claudethecaller, styled like the dashboard (same palette, cards, dots)."""

from __future__ import annotations

import asyncio
import copy
import difflib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
import numpy as np
import psycopg
import typer
from rich import box
from rich.columns import Columns
from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from ctc.config import ROOT, cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion import indexer
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.retrieval.hybrid import close_ctx, open_ctx, result_json, search
from ctc.runner import engine, proc, prune
from ctc.runner.engine import RUNS
from ctc.storage.cache import Cache
from ctc.storage.local import CACHE, LocalStore
from ctc.storage.store import Store

app = typer.Typer(no_args_is_help=True, add_completion=False, rich_markup_mode="rich",
                  help="claudethecaller: find the right skills, agents and workflows for a coding prompt.")
out = Console()
err = Console(stderr=True)

# Dashboard palette (dashboard/src/ui.tsx PALETTE + styles.css tokens).
BLUE, GREEN, ORANGE, PINK, PURPLE, TEAL = "#7c8cff", "#3ddc97", "#f59e42", "#ff6fae", "#b38cff", "#2dd4bf"
TEXT, MUTED, FAINT, LINE, BAD, WARN = "#ededef", "#8b8b93", "#5c5c64", "#2c2c31", "#ff6b6b", "#f5b14a"
KIND = {"skill": BLUE, "agent": PURPLE, "command": ORANGE, "workflow": GREEN}


# ---- dashboard-style pieces -------------------------------------------------

def dot(color: str) -> str:
    return f"[{color}]●[/]"


def tag(label: str, color: str = MUTED) -> str:
    return f"[{color} on #17171a] {label} [/]"


def kind_cell(kind: str) -> str:
    return f"{dot(KIND.get(kind, MUTED))} [{MUTED}]{kind}[/]"


def bar(frac: float, color: str, width: int = 12) -> str:
    n = max(0, min(width, round(frac * width)))
    return f"[{color}]{'━' * n}[/][{LINE}]{'━' * (width - n)}[/]"


def header(crumb: str, title: str, sub: str) -> Group:
    return Group(Text.from_markup(f"[{FAINT}]Board / [/][{MUTED}]{crumb}[/]"), Text.from_markup(f"[bold {TEXT}]{title}[/]"),
                 Text.from_markup(f"[{FAINT}]{sub}[/]"), Text(""))


def card(body, title: str = "", subtitle: str = "") -> Panel:
    return Panel(body, title=f"[bold {TEXT}]{title}[/]" if title else None, title_align="left",
                 subtitle=f"[{FAINT}]{subtitle}[/]" if subtitle else None, subtitle_align="right",
                 box=box.ROUNDED, border_style=LINE, padding=(1, 2))


def kpi(label: str, color: str, value: str, sub: str) -> Panel:
    body = Text.from_markup(f"{dot(color)} [{MUTED}]{label}[/]\n\n[bold {TEXT}]{value}[/]\n[{FAINT}]{sub}[/]")
    return Panel(body, box=box.ROUNDED, border_style=LINE, padding=(0, 2), width=26)


def grid(*cols: tuple[str, str]) -> Table:
    """Borderless table like the dashboard's: faint headers, thin row separators."""
    t = Table(box=box.SIMPLE_HEAD, border_style=LINE, header_style=FAINT, show_edge=False, pad_edge=False, expand=True)
    for name, spec in cols:
        just, _, w = spec.partition(":")
        t.add_column(name, justify="right" if just == "r" else "left", no_wrap=True, overflow="ellipsis",
                     **({"width": int(w)} if w.isdigit() else {"ratio": int(w[1:]) if w.startswith("*") else 1}))
    return t


# ---- plumbing ---------------------------------------------------------------

def _servers() -> dict[str, str]:
    c = cfg()
    out = {"embedder": c["embed_url"], "reranker": c["rerank_url"]}
    if c["llm"].startswith("openai:"):  # openai:<base url>:<model>; anthropic has no local server
        out["llm"] = c["llm"].split(":", 1)[1].rsplit(":", 1)[0].removesuffix("/v1")
    return out


def _host(url: str) -> str:
    """host:port only: never print credentials from a DSN or Redis URL."""
    if url.startswith(("postgres://", "postgresql://")) or "=" in url:
        d = psycopg.conninfo.conninfo_to_dict(url)
        return f"{d.get('host', 'localhost')}:{d.get('port', 5432)}/{d.get('dbname', '')}"
    u = urlsplit(url)
    return f"{u.hostname}:{u.port}" if u.port else str(u.hostname)


def _run(coro):
    """One asyncio.run per command: the psycopg pool and httpx clients are bound to the loop that made them."""
    try:
        return asyncio.run(coro)
    except httpx.ConnectError as e:
        url = str(e.request.url)
        name = next((n for n, base in _servers().items() if url.startswith(base)), "model server")
        err.print(f"[{BAD}]●[/] {name} unreachable at {_host(url)}  [{FAINT}]start the model servers:[/] [bold]docker compose up -d[/]")
    except httpx.HTTPError as e:
        err.print(f"[{BAD}]●[/] model server error: {e}")
    except psycopg.OperationalError as e:
        err.print(f"[{BAD}]●[/] database unreachable at {_host(cfg()['database_url'])}: {str(e).splitlines()[0]}")
    raise typer.Exit(1)


async def _searched(query: str, k: int):
    ctx = await open_ctx(Path.cwd())
    try:
        return ctx, await search(query, ctx, k=k)
    finally:
        await close_ctx(ctx)


async def _backends() -> tuple[dict | None, bool]:
    """(DB counts + library_version, None without a DB, {"error"} when unreachable; Redis up)."""
    c = cfg()
    cache = Cache(c["redis_url"], c["cache"])
    await cache.start()
    redis_up = cache.up
    await cache.close()
    if not c["database_url"]:
        return None, redis_up
    try:
        s = await Store.open(c["database_url"], pool_max=1)
    except (psycopg.Error, OSError) as e:
        return {"error": str(e).splitlines()[0]}, redis_up
    try:
        return {**await s.counts(), "library_version": s.library_version}, redis_up
    finally:
        await s.close()


def _flat(text: str) -> str:
    return " ".join(text.split())


# ---- commands -----------------------------------------------------------------

@app.command()
def status() -> None:
    """Capabilities found, model servers, database, cache and index state."""
    c = cfg()
    caps, warnings = scan_library(default_roots(Path.cwd()))
    up = {}
    for name, url in _servers().items():
        try:
            up[name] = (url, httpx.get(url + "/health", timeout=2).status_code == 200)
        except httpx.HTTPError:
            up[name] = (url, False)
    db, redis_up = asyncio.run(_backends())
    db_ok = bool(db) and "error" not in db
    if db_ok:
        vectors, where = db["vectors"], f"vectors · {db['capabilities']} caps"
    else:
        vectors = len(np.load(CACHE)["keys"]) if CACHE.exists() and db is None else 0
        where = "vectors, local cache" if db is None else "database unreachable"
    running = Path(c["socket"]).exists()

    out.print(header("Status", "claudethecaller", f"{Path.cwd()}"))
    n_up = sum(ok for _, ok in up.values())
    db_kpi = (kpi("Database", ORANGE, "local", "add CTC_DATABASE_URL") if db is None
              else kpi("Database", GREEN, "Postgres", f"library {db['library_version'][:8]}") if db_ok
              else kpi("Database", BAD, "down", _host(c["database_url"])))
    out.print(Columns([
        kpi("Capabilities", BLUE, f"{len(caps)}", f"{len(warnings)} files skipped"),
        kpi("Index", GREEN if vectors else WARN, f"{vectors}", "run ctc index" if not vectors and (db is None or db_ok) else where),
        kpi("Model servers", PURPLE if n_up == len(up) else WARN, f"{n_up}/{len(up)} up", "embed · rerank · llm"),
        db_kpi,
    ]))

    kinds = Counter(c.kind for c in caps)
    lib = grid(("kind", "l:12"), ("", "l:*3"), ("count", "r:7"))
    for k, n in kinds.most_common():
        lib.add_row(kind_cell(k), bar(n / max(kinds.values()), KIND.get(k, MUTED), 22), f"[{TEXT}]{n}[/]")
    svc = grid(("service", "l:12"), ("url", "l:*2"), ("", "r:8"))
    for name, (url, ok) in up.items():
        svc.add_row(name, f"[{FAINT}]{url}[/]", f"{dot(GREEN)} up" if ok else f"{dot(BAD)} down")
    svc.add_row("database", f"[{FAINT}]{_host(c['database_url']) + ' · schema ctc' if db is not None else 'in-memory LocalStore'}[/]",
                f"{dot(ORANGE)} unset" if db is None else f"{dot(GREEN)} up" if db_ok else f"{dot(BAD)} down")
    svc.add_row("redis", f"[{FAINT}]{_host(c['redis_url'])} · cache[/]", f"{dot(GREEN)} up" if redis_up else f"{dot(BAD)} down")
    svc.add_row("daemon", f"[{FAINT}]{c['socket']}[/]", f"{dot(GREEN)} on" if running else f"{dot(FAINT)} off")
    row = Table.grid(expand=True, padding=(0, 1))
    row.add_column(ratio=1)
    row.add_column(ratio=1)
    row.add_row(card(lib, "Library", f"{len(caps)} capabilities"), card(svc, "Services"))
    out.print(row)
    if db and not db_ok:
        err.print(f"[{BAD}]●[/] database: {db['error']}")


@app.command()
def caps(query: str = typer.Argument("", help="Filter by text in the id or description."),
         kind: str = typer.Option("", "--kind", "-k", help="skill, agent, command or workflow"),
         as_json: bool = typer.Option(False, "--json", help="Print JSON."),
         limit: int = typer.Option(50, "--limit", "-n")) -> None:
    """List the capabilities installed for this project."""
    found, _ = scan_library(default_roots(Path.cwd()))
    q = query.lower()
    rows = [c for c in found if (not kind or c.kind == kind) and (not q or q in (c.id + " " + c.description).lower())]
    if as_json:
        print(json.dumps([{"id": c.id, "kind": c.kind, "invoke": c.invoke, "description": c.description} for c in rows[:limit]], indent=2, ensure_ascii=False))
        return
    counts = Counter(c.kind for c in found if not q or q in (c.id + " " + c.description).lower())
    chips = "  ".join(f"{dot(KIND[k])} [{TEXT if not kind or k == kind else FAINT}]{k}[/] [{FAINT}]{n}[/]" for k, n in counts.most_common())
    t = grid(("capability", "l:*2"), ("kind", "l:12"), ("what it does", "l:*3"))
    for c in rows[:limit]:
        t.add_row(f"[bold {TEXT}]{c.id}[/]", kind_cell(c.kind), f"[{MUTED}]{_flat(c.description)}[/]")
    out.print(header("Library", "Capabilities", f"{len(rows)} match" + (f", showing {limit}" if len(rows) > limit else "")))
    out.print(card(Group(Text.from_markup(chips), Text(""), t), "Library", f"{len(found)} installed"))


@app.command()
def index() -> None:
    """Scan the library and embed it (only new or changed texts are embedded)."""
    c = cfg()

    async def local() -> tuple[int, int]:
        store, embedder = LocalStore(Path.cwd()), Embedder(c["embed_url"], c["batch_timeout_s"])
        try:
            return len(store.catalog), await store.build(embedder)
        finally:
            await embedder.aclose()

    with out.status(f"[{MUTED}]scanning and embedding capabilities…[/]", spinner_style=BLUE):
        r = _run(indexer.run(Path.cwd()) if c["database_url"] else local())
    if isinstance(r, dict):
        out.print(f"{dot(GREEN)} indexed  [bold]+{r['added']}[/] added · [bold]{r['changed']}[/] changed · [bold]-{r['removed']}[/] removed · "
                  f"[bold]{r['embedded']}[/] embedded · [bold]{r['vectors']}[/] vectors  [{FAINT}]library {r['library_version'][:8]} → {_host(c['database_url'])} schema ctc[/]")
    else:
        out.print(f"{dot(GREEN)} indexed [bold]{r[0]}[/] capabilities, [bold]{r[1]}[/] embedded  [{FAINT}]→ {CACHE}[/]")


@app.command("search")
def search_cmd(query: str = typer.Argument(..., help="A coding prompt, e.g. \"fix a flaky test\"."),
               k: int = typer.Option(5, "--top", "-k"),
               as_json: bool = typer.Option(False, "--json", help="Print JSON.")) -> None:
    """Best capabilities for a prompt."""
    ctx, res = _run(_searched(query, k))
    if as_json:
        print(json.dumps(result_json(query, ctx, res), indent=2, ensure_ascii=False))
        return
    ms = sum(res.ms.values())
    out.print(header("Search", f"“{query}”", f"{len(ctx.store.catalog)} capabilities searched in {ms:.0f} ms"))
    if res.abstained:
        out.print(card(Text.from_markup(f"{tag('abstained', WARN)}  [{MUTED}]no confident match; the router stays quiet[/]"), "Suggested"))
        return
    hi, lo = max(h.score for h in res.hits), min(h.score for h in res.hits)
    rel = lambda v: 1.0 if hi == lo else 0.25 + 0.75 * (v - lo) / (hi - lo)
    t = grid(("#", "r:3"), ("capability", "l:*2"), ("kind", "l:12"), ("score", "r:7"), ("", "l:12"), ("what it does", "l:*3"))
    for i, h in enumerate(res.hits, 1):
        cap = ctx.store.get(h.cap_id)
        color = KIND.get(cap["kind"], MUTED)
        t.add_row(f"[{FAINT}]{i}[/]", f"[bold {TEXT}]{cap['invoke']}[/]", kind_cell(cap["kind"]), f"{h.score:.3f}",
                  bar(rel(h.score), color), f"[{MUTED}]{_flat(cap['description'])}[/]")
    out.print(card(t, "Suggested", f"{tag(f'{ms:.0f} ms', BLUE)}  explain → ctc explain \"{query}\""))


@app.command()
def explain(query: str = typer.Argument(..., help="A coding prompt."),
            k: int = typer.Option(5, "--top", "-k")) -> None:
    """Every search stage for a prompt: why each hit ranked where it did."""
    ctx, res = _run(_searched(query, k))
    num = lambda v, d=2: f"[{FAINT}]—[/]" if v is None else (f"{v:.{d}f}" if isinstance(v, float) else str(v))
    shown = {h.cap_id for h in res.hits}
    verdict = (tag("abstained", WARN) if res.abstained else tag(f"{len(res.hits)} suggested", GREEN)) + (
        f"  gate p {res.p:.2f}" if res.p is not None else "")
    out.print(header("Explain", f"“{query}”", "dense + keyword candidates → RRF → filters → rerank → final = RRF(dense rank, rerank rank)"))

    t = grid(("#", "r:3"), ("capability", "l:*2"), ("kind", "l:12"), ("dense", "r:6"), ("dense #", "r:7"), ("keyword #", "r:9"),
             ("rrf", "r:7"), ("rerank", "r:7"), ("final", "r:7"), ("result", "l:14"))
    for i, h in enumerate(res.considered, 1):
        s = h.stages
        result = tag("suggested", GREEN) if h.cap_id in shown else f"[{FAINT}]below cut[/]"
        name = f"[bold {TEXT}]{h.cap_id}[/]" if h.cap_id in shown else f"[{MUTED}]{h.cap_id}[/]"
        t.add_row(f"[{FAINT}]{i}[/]", name, kind_cell(ctx.store.get(h.cap_id)["kind"]), num(s.get("dense")), num(s.get("dense_rank")),
                  num(s.get("sparse_rank")), num(s.get("rrf"), 4), num(s.get("rerank"), 3), num(s.get("final"), 4), result)
    for h, reason in res.dropped[:10]:
        t.add_row("", f"[{FAINT}]{h.cap_id}[/]", "", "", "", "", num(h.stages.get("rrf"), 4), "", "", tag("dropped", BAD) + f" [{FAINT}]{reason}[/]")
    out.print(card(t, "Why these", verdict))

    total = sum(res.ms.values()) or 1
    timing = grid(("stage", "l:12"), ("", "l:*3"), ("ms", "r:8"))
    for stage, v in res.ms.items():
        timing.add_row(f"[{MUTED}]{stage}[/]", bar(v / total, {"embed": BLUE, "candidates": GREEN, "filter": ORANGE, "rerank": PURPLE}.get(stage, PINK), 40), f"{v:.1f}")
    out.print(card(timing, "Timing", f"{total:.0f} ms total"))


# ---- daemon -------------------------------------------------------------------

daemon = typer.Typer(no_args_is_help=True, help="Start, stop or check the local daemon.")
app.add_typer(daemon, name="daemon")


def _pid_file() -> Path:
    return Path(cfg()["socket"]).parent / "daemon.pid"


def _alive() -> int | None:
    """Pid from daemon.pid if that process exists and is our daemon (a stale pid may be reused)."""
    try:
        pid = int(_pid_file().read_text())
        os.kill(pid, 0)
        return pid if b"ctc.server.app" in Path(f"/proc/{pid}/cmdline").read_bytes() else None
    except (OSError, ValueError):
        return None


def _health() -> dict | None:
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=cfg()["socket"]), timeout=2) as h:
            return h.get("http://ctc/v1/health").raise_for_status().json()
    except (httpx.HTTPError, ValueError):
        return None


def _health_line(h: dict) -> str:
    return "  ".join(f"{dot(GREEN if v == 'ok' else BAD)} [{MUTED}]{k}[/]" for k, v in h.items() if k not in ("library_version", "mode"))


@daemon.command("start")
def daemon_start() -> None:
    """Start the daemon in the background (socket + 127.0.0.1:port), log to ~/.claudethecaller/daemon.log."""
    c, pid_file = cfg(), _pid_file()
    if h := _health():
        out.print(f"{dot(GREEN)} daemon already running  [{FAINT}]pid {_alive() or '?'} · {c['socket']}[/]\n{_health_line(h)}")
        return
    if pid := _alive():
        err.print(f"[{BAD}]●[/] pid {pid} is alive but not answering on {c['socket']}  [{FAINT}]run[/] [bold]ctc daemon stop[/]")
        raise typer.Exit(1)
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log = pid_file.with_name("daemon.log")
    with log.open("ab") as f:
        p = subprocess.Popen([sys.executable, "-m", "ctc.server.app"], cwd=ROOT, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=f, stderr=f)
    pid_file.write_text(f"{p.pid}\n")
    with out.status(f"[{MUTED}]waiting for the daemon…[/]", spinner_style=BLUE):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and p.poll() is None and not (h := _health()):
            time.sleep(0.25)
    if not h:
        if p.poll() is not None:
            pid_file.unlink(missing_ok=True)
        err.print(f"[{BAD}]●[/] daemon {'exited' if p.poll() is not None else 'not answering after 20 s'}  [{FAINT}]see {log}[/]")
        raise typer.Exit(1)
    out.print(f"{dot(GREEN)} daemon started  [{FAINT}]pid {p.pid} · {c['socket']} · http://127.0.0.1:{c['port']}[/]\n{_health_line(h)}")


@daemon.command("stop")
def daemon_stop() -> None:
    """SIGTERM the daemon from daemon.pid and wait for it to exit."""
    pid_file = _pid_file()
    if not (pid := _alive()):
        pid_file.unlink(missing_ok=True)
        out.print(f"{dot(FAINT)} daemon not running" + (f"  [{FAINT}]but something answers on {cfg()['socket']} (started by hand?)[/]" if _health() else ""))
        return
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and _alive():
        time.sleep(0.1)
    if _alive():
        err.print(f"[{BAD}]●[/] pid {pid} still running after 15 s  [{FAINT}]kill -9 {pid}[/]")
        raise typer.Exit(1)
    pid_file.unlink(missing_ok=True)
    out.print(f"{dot(FAINT)} daemon stopped  [{FAINT}]pid {pid}[/]")


@daemon.command("status")
def daemon_status(as_json: bool = typer.Option(False, "--json", help="Print JSON.")) -> None:
    """Pid and /v1/health of the running daemon."""
    c, pid, h = cfg(), _alive(), _health()
    if as_json:
        print(json.dumps({"pid": pid, "health": h}, indent=2))
        return
    t = grid(("", "l:12"), ("", "l:*3"))
    t.show_header = False
    t.add_row("pid", f"{pid}" if pid else f"[{FAINT}]none[/]")
    t.add_row("socket", f"[{FAINT}]{c['socket']}[/]  " + (f"{dot(GREEN)} up" if h else f"{dot(BAD)} down"))
    t.add_row("http", f"[{FAINT}]http://127.0.0.1:{c['port']} · dashboard + /mcp[/]")
    if h:
        t.add_row("health", _health_line(h))
        t.add_row("library", f"[{FAINT}]{h.get('library_version', '')[:8]} · {h.get('mode')} mode[/]")
    out.print(card(t, "Daemon", tag("running", GREEN) if h else tag("stopped", FAINT)))
    if not h:
        raise typer.Exit(1)


# ---- history ------------------------------------------------------------------

history = typer.Typer(no_args_is_help=True, help="Import Claude Code history: sessions, decisions, memories (B9).")
app.add_typer(history, name="history")


def _history_card(s: dict, title: str) -> None:
    out.print(header("History", title, s["root"]))
    out.print(Columns([
        kpi("Transcripts", BLUE, f"{s['files']}", f"{s['imported']} imported"),
        kpi("Pending", WARN if s["pending"] else FAINT, f"{s['pending']}", "sessions to distill"),
        kpi("Processed", GREEN, f"{s['processed']}", "titles, intents, memories"),
        kpi("Failed", BAD if s["failed"] else FAINT, f"{s['failed']}", "retried on the next import"),
    ]))
    if j := s["last_job"]:
        color = {"done": GREEN, "failed": BAD}.get(j["status"], WARN)
        res = " · ".join(f"{k} {v}" for k, v in (j["result"] or {}).items() if v)
        out.print(f"{dot(color)} last import {tag(j['status'], color)}  [{FAINT}]{j['created_at'].astimezone():%Y-%m-%d %H:%M} · {res or j['error'] or ''}[/]")


@history.command("status")
def history_status() -> None:
    """Transcripts found and imported; sessions pending, processed and failed."""
    from ctc.ingestion import history as hist

    async def go() -> dict:
        s = await Store.open(cfg()["database_url"], pool_max=1)
        try:
            return await hist.status(s, "local", cfg()["claude_home"])
        finally:
            await s.close()
    _history_card(_run(go()), "Claude history")


@history.command("import")
def history_import(no_process: bool = typer.Option(False, "--no-process", help="Scan only: no LLM distill."),
                   project: str = typer.Option("", "--project", "-p", help="Only this project (name or folder name).")) -> None:
    """Scan ~/.claude/projects transcripts (seconds), then distill each pending session with the local LLM. A running
    daemon does the work (its worker owns the one LLM slot); without one it runs here."""
    from ctc.ingestion import history as hist
    from ctc.server import jobs
    from ctc.server.state import close_state, open_state

    async def go() -> tuple[dict, dict]:
        st = await open_state()
        try:
            job_id = await jobs.submit(st, "history", {"process": not no_process, **({"projects": [project]} if project else {})})
            daemon = _health() is not None
            with out.status(f"[{MUTED}]scanning transcripts{' (daemon)' if daemon else ''}…[/]", spinner_style=BLUE) as sp:
                if daemon:  # follow the daemon's jobs: the history job, then its distill jobs
                    while True:
                        await asyncio.sleep(1)
                        j, s = await jobs.get_job(st, job_id), await hist.status(st.store, "local", st.cfg["claude_home"])
                        busy = await st.store.fetchval("select count(*) from jobs where user_id = 'local' and kind in ('history', 'distill')"
                                                       " and status in ('queued', 'running')")
                        sp.update(f"[{MUTED}]daemon: {s['processed']} processed · {s['pending']} pending · {busy} jobs left…[/]")
                        if j["status"] in ("done", "failed") and (no_process or not busy):
                            break
                else:
                    await jobs._run(st, job_id)
                    todo = [] if no_process else await st.store.fetch(
                        "select id::text as id from jobs where user_id = 'local' and kind = 'distill' and status = 'queued' order by created_at")
                    for i, r in enumerate(todo, 1):
                        sp.update(f"[{MUTED}]distilling session {i}/{len(todo)} with the local LLM…[/]")
                        await jobs._run(st, r["id"])
                    if todo:
                        await hist.outcomes(st)  # the history job ran phase 3 before these distills
            return await jobs.get_job(st, job_id), await hist.status(st.store, "local", st.cfg["claude_home"])
        finally:
            await close_state(st)

    j, s = _run(go())
    _history_card(s, "Claude history imported" if j["status"] == "done" else "Claude history import failed")
    if j["status"] != "done":
        err.print(f"[{BAD}]●[/] {j['error']}")
        raise typer.Exit(1)
# ---- workflow runs (PLAN.md m5) -----------------------------------------------

STATUS = {"done": GREEN, "skipped": FAINT, "cancelled": FAINT, "failed": BAD, "timeout": BAD, "quota": WARN,
          "queued": BLUE, "running": WARN, "waiting": WARN}


def _api(method: str, path: str, **kw):
    """One /api call to the daemon over its socket; an API error (code, message, node) ends the command."""
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=cfg()["socket"]), timeout=30) as h:
            r = h.request(method, "http://ctc/api" + path, **kw)
    except httpx.HTTPError:
        err.print(f"[{BAD}]●[/] daemon not answering on {cfg()['socket']}  [{FAINT}]run[/] [bold]ctc daemon start[/]")
        raise typer.Exit(1) from None
    if r.is_error:
        e = r.json().get("error", {}) if "json" in r.headers.get("content-type", "") else {}
        node = f"  [{FAINT}]node {e['node_id']}[/]" if e.get("node_id") else ""
        err.print(f"[{BAD}]●[/] {e.get('code', r.status_code)}: {e.get('message', r.text)}{node}")
        raise typer.Exit(1)
    return r.json()


def _workflow_id(name: str) -> str:
    """A cap id as is; a bare name -> the one workflow of that name (several: list them and stop)."""
    if ":" in name:
        return name
    rows = _api("GET", "/capabilities", params={"kind": "workflow", "q": name, "limit": 500})
    ids = [c["id"] for c in rows if c["id"].rpartition(":")[2] == name]
    if len(ids) == 1:
        return ids[0]
    err.print(f"[{BAD}]●[/] " + (f"{name} is ambiguous, pass one id: {', '.join(ids)}" if ids
                                  else f"no workflow named {name}  [{FAINT}]run[/] [bold]ctc index[/]"))
    raise typer.Exit(1)


def _status(s: str) -> str:
    return f"{dot(STATUS.get(s, MUTED))} {s}"


@app.command("run")
def run_cmd(workflow: str = typer.Argument(..., help="Workflow id or name, e.g. smoke."),
            text: str = typer.Option("", "--input", "-i", help="The run's {{input}}."),
            project: str | None = typer.Option(None, "--project", "-p", help="Project name, for a user or plugin workflow."),
            wait: bool = typer.Option(False, "--wait", "-w", help="Wait for the end and show every node."),
            pinned: bool = typer.Option(False, "--pinned", help="Pinned nodes return their pinned output: no agent runs, "
                                        "no commit. For testing IF, loops and templates.")) -> None:
    """Queue a workflow run on the daemon: its own git worktree and branch, your claude login."""
    cap_id = _workflow_id(workflow)
    rid = _api("POST", f"/workflows/{quote(cap_id, safe=':@')}/runs",
               json={"input": text, "project": project, "trigger": "cli", "pinned": pinned})["run_id"]
    out.print(f"{dot(BLUE)} run [bold]#{rid}[/] queued  [{FAINT}]{cap_id}{' · pinned' if pinned else ''}[/]")
    if not wait:
        return
    with out.status(f"[{MUTED}]running #{rid}…[/]", spinner_style=BLUE):
        while (r := _api("GET", f"/runs/{rid}"))["status"] in ("queued", "running"):
            time.sleep(cfg()["runner"]["poll_s"])
    t = grid(("node", "l:*2"), ("status", "l:12"), ("tokens", "r:9"), ("error", "l:*4"))
    for s in r["steps"]:
        t.add_row(f"[{TEXT}]{s['node_id']}[/][{FAINT}]#{s['visit']}[/]", _status(s["status"]),
                  f"{sum((s['tokens'] or {}).values()):,}", f"[{FAINT}]{_flat(s['error'] or '')}[/]")
    out.print(card(t, f"Run #{rid} · {r['workflow']}", " · ".join(x for x in (r["branch"], f"{r['tokens']:,} tokens") if x)))
    out.print(_status(r["status"]) + (f"  [{FAINT}]{_flat(r['error'])}[/]" if r["error"] else ""))
    if r["status"] != "done":
        raise typer.Exit(1)


runs = typer.Typer(help="Recent workflow runs; `ctc runs prune` removes old ones.")
app.add_typer(runs, name="runs")


@runs.callback(invoke_without_command=True)
def runs_cmd(ctx: typer.Context, limit: int = typer.Option(20, "--limit", "-n")) -> None:
    """Recent workflow runs of this claude login."""
    if ctx.invoked_subcommand is not None:
        return
    rows = _api("GET", "/runs", params={"limit": limit})
    t = grid(("run", "r:6"), ("workflow", "l:*3"), ("status", "l:12"), ("trigger", "l:9"), ("nodes", "r:7"), ("tokens", "r:10"),
             ("created", "l:16"))
    for r in rows:
        t.add_row(f"#{r['id']}", f"[{TEXT}]{r['workflow']}[/]", _status(r["status"]), f"[{MUTED}]{r['trigger']}[/]",
                  f"{r['nodes_done']}/{r['nodes_total']}", f"{r['tokens']:,}", f"[{FAINT}]{r['created_at'][:16].replace('T', ' ')}[/]")
    out.print(card(t, "Runs", f"{len(rows)} shown"))


@runs.command("prune")
def runs_prune(days: int = typer.Option(30, "--days", min=1, help="Prune runs that ended more than this many days ago."),
               apply: bool = typer.Option(False, "--apply", help="Delete; without it this is a dry run.")) -> None:
    """List runs older than --days that are done, failed or cancelled with no PR URL, and what would be removed
    (worktree, ctc/* branch, gz logs, rows). Deletes only with --apply."""
    async def go() -> tuple[list[dict], dict | None]:
        if not (o := await engine.owner()):
            err.print(f"[{BAD}]●[/] claude auth status shows no login")
            raise typer.Exit(1)
        st = await Store.open(cfg()["database_url"], pool_max=1)
        try:
            items = await prune.candidates(st, o, days)
            return items, await prune.apply(st, o, items) if apply and items else None
        finally:
            await st.close()

    items, totals = _run(go())
    if not items:
        out.print(f"{dot(FAINT)} nothing to prune (older than {days} days)")
        return
    t = grid(("run", "r:6"), ("workflow", "l:*3"), ("age", "r:6"), ("branch", "l:*3"), ("size", "r:9"))
    for i in items:
        t.add_row(f"#{i['id']}", f"[{TEXT}]{i['workflow']}[/]", f"{i['age_days']}d", f"[{MUTED}]{i['branch'] or ''}[/]",
                  f"{i['size'] / 1e6:.1f} MB")
    sub = (f"pruned {totals['runs']} runs · {totals['worktrees']} worktrees · {totals['branches']} branches · "
           f"{totals['bytes'] / 1e6:.1f} MB freed" if totals else "dry run · nothing deleted · pass --apply")
    out.print(card(t, "Prune runs", sub))


@app.command("cancel")
def cancel_cmd(run_id: int = typer.Argument(..., help="Run id, from ctc runs.")) -> None:
    """Cancel a workflow run: a running node's process group is stopped; a queued run never starts."""
    r = _api("POST", f"/runs/{run_id}/cancel")
    out.print(f"{_status(r['status'])}  [{FAINT}]run #{r['id']} · {r['workflow']}[/]")


@app.command("continue")
def continue_cmd(run_id: int = typer.Argument(..., help="Run id, from ctc runs."),
                 now: bool = typer.Option(False, "--now", help="Go now, not at the usage reset.")) -> None:
    """Continue a run stopped at a usage limit: at its reset (default) or now. Its stopped node goes on in its own session."""
    r = _api("POST", f"/runs/{run_id}/continue", json={"when": "now" if now else "reset"})
    when = (f" · goes on at {datetime.fromisoformat(r['quota_resets_at']).astimezone():%Y-%m-%d %H:%M}"  # local, like "resets 3pm"
            if r["status"] == "quota" and r["quota_resets_at"] else "")
    out.print(f"{_status(r['status'])}  [{FAINT}]run #{r['id']} · {r['workflow']}{when}[/]")


def _approve(run_id: int, ok: bool, note: str | None) -> None:
    r = _api("POST", f"/runs/{run_id}/approve", json={"approve": ok, "note": note})  # not waiting: 409 not_waiting
    out.print(f"{_status(r['status'])}  [{FAINT}]run #{r['id']} · {r['workflow']}[/]")


@app.command("approve")
def approve_cmd(run_id: int = typer.Argument(..., help="Run id, from ctc runs."),
                note: str | None = typer.Option(None, "--note", "-m", help="Saved on the approval step.")) -> None:
    """Approve a run waiting at an approval node: it walks on."""
    _approve(run_id, True, note)


@app.command("reject")
def reject_cmd(run_id: int = typer.Argument(..., help="Run id, from ctc runs."),
               note: str | None = typer.Option(None, "--note", "-m", help="Saved on the approval step.")) -> None:
    """Reject a run waiting at an approval node: it ends cancelled."""
    _approve(run_id, False, note)


@app.command("retry")
def retry_cmd(run_id: int = typer.Argument(..., help="Run id, from ctc runs."),
              from_node: str | None = typer.Option(None, "--from", help="Start at this node, reusing the earlier nodes' outputs (default: the failed step, else the start)."),
              to_node: str | None = typer.Option(None, "--to", help="Stop with done after this node.")) -> None:
    """Start a new run from an earlier run, on a worktree reset to the start node's commit."""
    r = _api("POST", f"/runs/{run_id}/retry", json={"from_node": from_node, "to_node": to_node, "trigger": "cli"})
    where = (f" from {from_node}" if from_node else "") + (f" to {to_node}" if to_node else "")
    out.print(f"{dot(BLUE)} run [bold]#{r['run_id']}[/] queued  [{FAINT}]retry of #{run_id}{where}[/]")


runner = typer.Typer(no_args_is_help=True, help="The workflow runner's pinned claude CLI.")
app.add_typer(runner, name="runner")


@runner.command("upgrade")
def runner_upgrade() -> None:
    """Pin the installed claude: check its claude.ai login, run one tiny readonly haiku prompt with it, then rewrite
    runner.claude_version in config/server.yaml."""
    async def smoke() -> tuple[dict, dict | None]:
        pre = await proc.preflight()  # its version error is what this command fixes; any other error stops here
        if pre["authMethod"] != "claude.ai" or not pre["claude_version"]:
            return pre, None
        argv, prompt = proc.agent_argv({"prompt": "Reply with one short word.", "model": "haiku", "readonly": True}, {}, str(uuid.uuid4()))
        RUNS.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNS) as d:  # under RUNS: the router hooks ignore it
            return pre, await proc.run_agent(argv, prompt, d, str(Path(d) / "smoke.jsonl"), 300)

    with out.status(f"[{MUTED}]auth smoke…[/]", spinner_style=BLUE):
        pre, r = asyncio.run(smoke())
    if not r or r["status"] != "done":
        err.print(f"[{BAD}]●[/] auth smoke failed: {pre['error'] if not r else r['error'] or r['status']}")
        raise typer.Exit(1)
    p, old = ROOT / "config" / "server.yaml", cfg()["runner"]["claude_version"]
    p.write_text(re.sub(r'(claude_version:\s*")[^"]*"', lambda m: f'{m.group(1)}{pre["claude_version"]}"', p.read_text(), count=1))
    out.print(f"{dot(GREEN)} runner pinned to claude [bold]{pre['claude_version']}[/]  [{FAINT}]was {old} · smoke said {r['output']['result']!r}[/]")


# ---- install ------------------------------------------------------------------

# event -> (route, curl max seconds); ours are recognised by the socket name in the command
HOOKS = {"UserPromptSubmit": ("prompt", "0.15"), "PostToolUse": ("tool", "0.05"), "Stop": ("stop", "0.05"),
         "SessionEnd": ("stop", "0.05")}  # same endpoint: it reads hook_event_name
MCP = "claudethecaller"


def _hook_cmd(route: str, t: str) -> str:
    return f"LC_ALL=C curl -sf -m {t} --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/v1/hook/{route} || true"


def _ours(h: dict) -> bool:
    return "ctc.sock" in str(h.get("command", ""))


def _settings() -> tuple[Path, dict]:
    p = Path(cfg()["claude_home"]) / "settings.json"
    return p, json.loads(p.read_text()) if p.exists() else {}


def _save(p: Path, old: dict, new: dict, dry_run: bool) -> bool:
    """Print the diff; unless dry_run, back up the old file and replace it atomically. False when nothing changes."""
    a, b = (json.dumps(d, indent=2, ensure_ascii=False).splitlines() for d in (old, new))
    diff = list(difflib.unified_diff(a, b, str(p), str(p), lineterm="", n=2))
    for line in diff[2:]:
        out.print(Text(line, style=GREEN if line[0] == "+" else BAD if line[0] == "-" else FAINT), soft_wrap=True)
    if not diff or dry_run:
        return bool(diff)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        backup = p.with_name(f"{p.name}.ctc-backup-{datetime.now(UTC):%Y%m%dT%H%M%S.%fZ}")
        shutil.copy2(p, backup)
        out.print(f"{dot(FAINT)} backup  [{FAINT}]{backup}[/]")
    tmp = p.with_name(p.name + ".ctc-tmp")
    tmp.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n")
    if p.exists():
        shutil.copymode(p, tmp)
    os.replace(tmp, p)
    return True


def _real_home() -> bool:
    return Path(cfg()["claude_home"]) == Path("~/.claude").expanduser()


@app.command()
def install(dry_run: bool = typer.Option(False, "--dry-run", help="Print the settings.json diff, write nothing."),
            yes: bool = typer.Option(False, "--yes", "-y", help="Also run `claude mcp add` (real ~/.claude only).")) -> None:
    """Add the claudethecaller hooks to Claude Code's settings.json (only missing ones) and register the MCP server."""
    c = cfg()
    p, old = _settings()
    new = copy.deepcopy(old)
    hooks = new.setdefault("hooks", {})
    added = []
    for event, (route, t) in HOOKS.items():
        groups = hooks.get(event, [])
        if not any(_ours(h) for g in groups for h in g.get("hooks", [])):
            hooks[event] = [*groups, {**({"matcher": "*"} if event == "PostToolUse" else {}),
                                      "hooks": [{"type": "command", "command": _hook_cmd(route, t)}]}]
            added.append(event)
    out.print(header("Install", "Claude Code hooks", f"{p}" + ("  · dry run" if dry_run else "")))
    if added:
        _save(p, old, new, dry_run)
        out.print(f"{dot(GREEN)} {'would add' if dry_run else 'added'} {', '.join(added)}")
    else:
        out.print(f"{dot(GREEN)} hooks already installed  [{FAINT}]nothing to change[/]")

    add = ["claude", "mcp", "add", "--scope", "user", "--transport", "http", MCP, f"http://127.0.0.1:{c['port']}/mcp"]
    if not (_real_home() and yes and not dry_run and shutil.which("claude")):
        why = ("dry run" if dry_run else "not the real ~/.claude" if not _real_home()
               else "claude not on PATH" if not shutil.which("claude") else "pass --yes to run it")
        out.print(f"{dot(FAINT)} MCP  [{FAINT}]{why}; run:[/] [bold]{' '.join(add)}[/]")
    elif subprocess.run(["claude", "mcp", "get", MCP], check=False, capture_output=True).returncode == 0:
        out.print(f"{dot(GREEN)} MCP server {MCP} already registered")
    else:
        r = subprocess.run(add, check=False, capture_output=True, text=True)
        out.print(f"{dot(GREEN)} MCP server {MCP} added" if r.returncode == 0 else f"{dot(BAD)} claude mcp add failed: {r.stderr.strip()}")
        if r.returncode:
            raise typer.Exit(1)


@app.command()
def uninstall(dry_run: bool = typer.Option(False, "--dry-run", help="Print the settings.json diff, write nothing.")) -> None:
    """Remove exactly the claudethecaller hooks from settings.json."""
    p, old = _settings()
    new = copy.deepcopy(old)
    hooks = new.get("hooks", {})
    for event in list(hooks):
        kept = []
        for g in hooks[event]:
            hs = [h for h in g.get("hooks", []) if not _ours(h)]
            if hs or not g.get("hooks"):  # drop only the groups we emptied
                kept.append({**g, "hooks": hs} if "hooks" in g else g)
        if kept != hooks[event]:
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
    if "hooks" in new and not hooks and old.get("hooks") != hooks:
        del new["hooks"]
    out.print(header("Uninstall", "Claude Code hooks", f"{p}" + ("  · dry run" if dry_run else "")))
    changed = _save(p, old, new, dry_run)
    out.print(f"{dot(GREEN)} {('would remove' if dry_run else 'removed') + ' our hooks' if changed else 'no claudethecaller hooks found'}")
    out.print(f"{dot(FAINT)} MCP  [{FAINT}]run:[/] [bold]claude mcp remove --scope user {MCP}[/]")


if __name__ == "__main__":
    app()
