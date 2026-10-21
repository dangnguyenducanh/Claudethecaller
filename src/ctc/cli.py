"""`ctc`: command-line front end for claudethecaller, styled like the dashboard (same palette, cards, dots)."""

from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from pathlib import Path

import httpx
import numpy as np
import typer
from rich import box
from rich.columns import Columns
from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.retrieval.hybrid import open_ctx, result_json, search
from ctc.storage.local import CACHE

app = typer.Typer(no_args_is_help=True, add_completion=False, rich_markup_mode="rich",
                  help="claudethecaller: find the right skills, agents and workflows for a coding prompt.")
out = Console()
err = Console(stderr=True)

# Dashboard palette (dashboard/src/ui.tsx PALETTE + styles.css tokens).
BLUE, GREEN, ORANGE, PINK, PURPLE, TEAL = "#7c8cff", "#3ddc97", "#f59e42", "#ff6fae", "#b38cff", "#2dd4bf"
TEXT, MUTED, FAINT, LINE, BAD, WARN = "#ededef", "#8b8b93", "#5c5c64", "#2c2c31", "#ff6b6b", "#f5b14a"
KIND = {"skill": BLUE, "agent": PURPLE, "command": ORANGE, "workflow": GREEN}
SERVERS = {"embedder": ("CTC_TEI_EMBED_URL", "http://127.0.0.1:18300"), "reranker": ("CTC_TEI_RERANK_URL", "http://127.0.0.1:18301"),
           "llm": ("CTC_LLM_URL", "http://127.0.0.1:18302")}


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

def _ctx():
    try:
        return asyncio.run(open_ctx(Path.cwd()))
    except httpx.HTTPError:
        err.print(f"[{BAD}]●[/] embedder unreachable at {Embedder().base_url}  [{FAINT}]start the model servers:[/] [bold]docker compose up -d[/]")
        raise typer.Exit(1)


def _search(query: str, k: int):
    ctx = _ctx()
    try:
        return ctx, asyncio.run(search(query, ctx, k=k))
    except httpx.HTTPError as e:
        err.print(f"[{BAD}]●[/] model server error: {e}")
        raise typer.Exit(1)


def _flat(text: str) -> str:
    return " ".join(text.split())


# ---- commands -----------------------------------------------------------------

@app.command()
def status() -> None:
    """Capabilities found, model servers, database and index state."""
    caps, warnings = scan_library(default_roots(Path.cwd()))
    up = {}
    for name, (env, default) in SERVERS.items():
        url = os.environ.get(env, default)
        try:
            up[name] = (url, httpx.get(url + "/health", timeout=2).status_code == 200)
        except httpx.HTTPError:
            up[name] = (url, False)
    env_file = Path(".env")
    has_db = "CTC_DATABASE_URL" in os.environ or (env_file.exists() and "CTC_DATABASE_URL=" in env_file.read_text())
    vectors = len(np.load(CACHE)["keys"]) if CACHE.exists() else 0
    running = (Path.home() / ".claudethecaller" / "ctc.sock").exists()

    out.print(header("Status", "claudethecaller", f"{Path.cwd()}"))
    n_up = sum(ok for _, ok in up.values())
    out.print(Columns([
        kpi("Capabilities", BLUE, f"{len(caps)}", f"{len(warnings)} files skipped"),
        kpi("Index", GREEN, f"{vectors}", "vectors, local cache" if vectors else "run ctc index"),
        kpi("Model servers", PURPLE if n_up == len(up) else WARN, f"{n_up}/{len(up)} up", "embed · rerank · llm"),
        kpi("Database", GREEN if has_db else ORANGE, "Supabase" if has_db else "local", "configured" if has_db else "add CTC_DATABASE_URL"),
    ]))

    kinds = Counter(c.kind for c in caps)
    lib = grid(("kind", "l:12"), ("", "l:*3"), ("count", "r:7"))
    for k, n in kinds.most_common():
        lib.add_row(kind_cell(k), bar(n / max(kinds.values()), KIND.get(k, MUTED), 22), f"[{TEXT}]{n}[/]")
    svc = grid(("service", "l:12"), ("url", "l:*2"), ("", "r:8"))
    for name, (url, ok) in up.items():
        svc.add_row(name, f"[{FAINT}]{url}[/]", f"{dot(GREEN)} up" if ok else f"{dot(BAD)} down")
    svc.add_row("database", f"[{FAINT}]Supabase · schema ctc[/]", f"{dot(GREEN)} set" if has_db else f"{dot(ORANGE)} unset")
    svc.add_row("daemon", f"[{FAINT}]~/.claudethecaller/ctc.sock[/]", f"{dot(GREEN)} on" if running else f"{dot(FAINT)} off")
    row = Table.grid(expand=True, padding=(0, 1))
    row.add_column(ratio=1)
    row.add_column(ratio=1)
    row.add_row(card(lib, "Library", f"{len(caps)} capabilities"), card(svc, "Services"))
    out.print(row)


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
    """Embed every capability (cached; only new or changed ones are embedded)."""
    with out.status(f"[{MUTED}]embedding capabilities…[/]", spinner_style=BLUE):
        ctx = _ctx()
    out.print(f"{dot(GREEN)} indexed [bold]{len(ctx.store.caps)}[/] capabilities  [{FAINT}]→ {CACHE}[/]")


@app.command("search")
def search_cmd(query: str = typer.Argument(..., help="A coding prompt, e.g. \"fix a flaky test\"."),
               k: int = typer.Option(5, "--top", "-k"),
               as_json: bool = typer.Option(False, "--json", help="Print JSON.")) -> None:
    """Best capabilities for a prompt."""
    ctx, res = _search(query, k)
    if as_json:
        print(json.dumps(result_json(query, ctx, res), indent=2, ensure_ascii=False))
        return
    ms = sum(res.ms.values())
    out.print(header("Search", f"“{query}”", f"{len(ctx.store.caps)} capabilities searched in {ms:.0f} ms"))
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
    ctx, res = _search(query, k)
    num = lambda v, d=2: f"[{FAINT}]—[/]" if v is None else (f"{v:.{d}f}" if isinstance(v, float) else str(v))
    shown = {h.cap_id for h in res.hits}
    verdict = tag("abstained", WARN) if res.abstained else tag(f"{len(res.hits)} suggested", GREEN)
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
