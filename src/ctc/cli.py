"""`ctc`: command-line front end for claudethecaller."""

from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from pathlib import Path

import httpx
import typer
from rich.console import Console
from rich.table import Table

from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.retrieval.hybrid import open_ctx, result_json, search
from ctc.storage.local import CACHE

app = typer.Typer(no_args_is_help=True, add_completion=False, rich_markup_mode="rich",
                  help="claudethecaller: find the right skills, agents and workflows for a coding prompt.")
out = Console()
err = Console(stderr=True)
KIND_STYLE = {"skill": "cyan", "agent": "magenta", "command": "yellow", "workflow": "green"}
SERVERS = {"embedder": "CTC_TEI_EMBED_URL", "reranker": "CTC_TEI_RERANK_URL", "llm": "CTC_LLM_URL"}
DEFAULT_URLS = {"embedder": "http://127.0.0.1:18300", "reranker": "http://127.0.0.1:18301", "llm": "http://127.0.0.1:18302"}


def _ctx():
    try:
        return asyncio.run(open_ctx(Path.cwd()))
    except httpx.HTTPError:
        err.print(f"[red]embedder unreachable at {Embedder().base_url}[/] — start the model servers: [bold]docker compose up -d[/]")
        raise typer.Exit(1)


def _search(query: str, k: int):
    ctx = _ctx()
    try:
        return ctx, asyncio.run(search(query, ctx, k=k))
    except httpx.HTTPError as e:
        err.print(f"[red]model server error:[/] {e}")
        raise typer.Exit(1)


def _kind(kind: str) -> str:
    return f"[{KIND_STYLE.get(kind, 'white')}]{kind}[/]"


@app.command()
def status() -> None:
    """Capabilities found, model servers, database and index state."""
    caps, warnings = scan_library(default_roots(Path.cwd()))
    t = Table(show_header=False, box=None, pad_edge=False)
    t.add_column(style="dim")
    t.add_column()
    kinds = Counter(c.kind for c in caps)
    t.add_row("capabilities", f"[bold]{len(caps)}[/]  " + "  ".join(f"{_kind(k)} {n}" for k, n in kinds.most_common()))
    if warnings:
        t.add_row("scan warnings", f"[yellow]{len(warnings)}[/] (skipped files)")
    for name, env in SERVERS.items():
        url = os.environ.get(env, DEFAULT_URLS[name])
        try:
            ok = httpx.get(url + "/health", timeout=2).status_code == 200
        except httpx.HTTPError:
            ok = False
        t.add_row(name, f"[green]up[/]  {url}" if ok else f"[red]down[/]  {url}")
    env_file = Path(".env")
    has_db = "CTC_DATABASE_URL" in os.environ or (env_file.exists() and "CTC_DATABASE_URL=" in env_file.read_text())
    t.add_row("database", "[green]configured[/] (CTC_DATABASE_URL)" if has_db else "[yellow]not configured[/] — local index only (add CTC_DATABASE_URL to .env)")
    t.add_row("index", f"{CACHE} ([bold]{len(__import__('numpy').load(CACHE)['keys'])}[/] vectors)" if CACHE.exists() else "[yellow]not built[/] — run [bold]ctc index[/]")
    sock = Path.home() / ".claudethecaller" / "ctc.sock"
    t.add_row("daemon", "[green]running[/]" if sock.exists() else "[dim]not running (arrives with B5)[/]")
    out.print(t)


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
    t = Table(title=f"{len(rows)} capabilities" + (f" (showing {limit})" if len(rows) > limit else ""), title_justify="left", header_style="dim")
    t.add_column("id", style="bold", no_wrap=True)
    t.add_column("kind")
    t.add_column("description", overflow="ellipsis", max_width=80, no_wrap=True)
    for c in rows[:limit]:
        t.add_row(c.id, _kind(c.kind), c.description)
    out.print(t)


@app.command()
def index() -> None:
    """Embed every capability (cached; only new or changed ones are embedded)."""
    with out.status("embedding capabilities…"):
        ctx = _ctx()
    out.print(f"[green]indexed[/] {len(ctx.store.caps)} capabilities → {CACHE}")


@app.command("search")
def search_cmd(query: str = typer.Argument(..., help="A coding prompt, e.g. \"fix a flaky test\"."),
               k: int = typer.Option(5, "--top", "-k"),
               as_json: bool = typer.Option(False, "--json", help="Print JSON.")) -> None:
    """Best capabilities for a prompt."""
    ctx, res = _search(query, k)
    if as_json:
        print(json.dumps(result_json(query, ctx, res), indent=2, ensure_ascii=False))
        return
    if res.abstained:
        out.print(f"[yellow]no confident match[/] — the router would stay quiet. See why: [bold]ctc explain \"{query}\"[/]")
        return
    t = Table(header_style="dim", title=f"[dim]{sum(res.ms.values()):.0f} ms[/]", title_justify="right")
    t.add_column("#", justify="right", style="dim")
    t.add_column("capability", style="bold", no_wrap=True)
    t.add_column("kind")
    t.add_column("score", justify="right")
    t.add_column("what it does", overflow="ellipsis", max_width=70, no_wrap=True)
    for i, h in enumerate(res.hits, 1):
        cap = ctx.store.get(h.cap_id)
        t.add_row(str(i), cap["invoke"], _kind(cap["kind"]), f"{h.score:.3f}", cap["description"])
    out.print(t)


@app.command()
def explain(query: str = typer.Argument(..., help="A coding prompt."),
            k: int = typer.Option(5, "--top", "-k")) -> None:
    """Every search stage for a prompt: why each hit ranked where it did."""
    ctx, res = _search(query, k)
    fmt = lambda v, d=2: "—" if v is None else (f"{v:.{d}f}" if isinstance(v, float) else str(v))
    t = Table(header_style="dim", title=f"[bold]{query}[/]  " + ("[yellow]abstained[/]" if res.abstained else f"[green]{len(res.hits)} suggested[/]"), title_justify="left")
    for col, just in [("#", "right"), ("capability", "left"), ("kind", "left"), ("dense", "right"), ("dense #", "right"),
                      ("keyword #", "right"), ("rrf", "right"), ("rerank", "right"), ("final", "right"), ("", "left")]:
        t.add_column(col, justify=just, no_wrap=True)
    shown = {h.cap_id for h in res.hits}
    for i, h in enumerate(res.considered, 1):
        s = h.stages
        mark = "[green]✓ suggested[/]" if h.cap_id in shown else "[dim]below cut[/]"
        t.add_row(str(i), h.cap_id, _kind(ctx.store.get(h.cap_id)["kind"]), fmt(s.get("dense")), fmt(s.get("dense_rank")),
                  fmt(s.get("sparse_rank")), fmt(s.get("rrf"), 4), fmt(s.get("rerank"), 3), fmt(s.get("final"), 4), mark)
    for h, reason in res.dropped[:10]:
        t.add_row("", f"[dim]{h.cap_id}[/]", "", "", "", "", fmt(h.stages.get("rrf"), 4), "", "", f"[red]dropped:[/] {reason}")
    out.print(t)
    out.print("[dim]" + "  ".join(f"{stage} {v:.0f} ms" for stage, v in res.ms.items()) + "  · final = RRF(dense rank, rerank rank); keywords only add candidates[/]")


if __name__ == "__main__":
    app()
