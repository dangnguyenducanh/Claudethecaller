"""`ctc`: command-line front end for claudethecaller, styled like the dashboard (same palette, cards, dots)."""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

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

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion import indexer
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.retrieval.hybrid import close_ctx, open_ctx, result_json, search
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


if __name__ == "__main__":
    app()
