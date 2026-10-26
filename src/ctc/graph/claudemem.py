"""claude-mem observations as context nodes (m6 G3, research.md R5). Read-only: one GET to the local worker, never a POST."""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

TYPES = {"decision", "bugfix", "feature", "refactor", "discovery"}


def project(cfg: dict, repo: Path) -> str:
    """claude-mem's name for repo: graph_links.claudemem_project, else `<owner>/<Repo>` of the origin remote (claude-mem's
    git naming), else the folder name."""
    if name := cfg["graph_links"].get("claudemem_project"):
        return name
    url = subprocess.run(["git", "-C", str(repo), "remote", "get-url", "origin"], capture_output=True, text=True,
                         check=False).stdout.strip()
    parts = re.split(r"[/:]", url.removesuffix(".git"))
    return "/".join(parts[-2:]) if url and len(parts) > 1 else Path(repo).resolve().name


async def fetch(cfg: dict, repo: Path, after_id: int) -> list[dict] | None:
    """Observations with id > after_id; None when the worker is down, slow (1 s) or answers garbage.
    ponytail: one page of the newest 200; more than 200 new observations between two builds loses the oldest ones."""
    try:
        async with httpx.AsyncClient(timeout=1) as c:
            r = await c.get(cfg["graph_links"]["claudemem_url"].rstrip("/") + "/api/observations",
                            params={"project": project(cfg, repo), "limit": 200})
            r.raise_for_status()
            return [i for i in r.json()["items"] if i["id"] > after_id]
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.info("claude-mem not read: %s: %s", type(e).__name__, e)
        return None


def _list(v) -> list[str]:
    """claude-mem keeps facts and file lists as JSON strings ('["a"]'); real lists pass through."""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return [v] if v else []
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def to_graph(items: list[dict], repo: Path | None = None) -> tuple[list[dict], list[dict]]:
    """Observation nodes (kept types only) + EXTRACTED `mentions` edges to `file:<path>` placeholders for the files it
    read or modified (repo-relative when under repo)."""
    root = f"{Path(repo).resolve()}/" if repo else "\0"
    nodes, edges = [], []
    for i in items:
        if i.get("type") not in TYPES:
            continue
        nid = f"ctx:claude-mem:obs-{i['id']}"
        text = "\n".join([i.get("subtitle") or "", i.get("narrative") or "", *_list(i.get("facts"))]).strip()
        nodes.append({"id": nid, "kind": "context", "type": "observation", "label": i.get("title") or nid, "text": text,
                      "source_file": None, "source_line": None, "origin": "claude-mem", "meta": {"obs_type": i["type"]}})
        for f in dict.fromkeys(_list(i.get("files_read")) + _list(i.get("files_modified"))):
            edges.append({"src": nid, "dst": f"file:{f.removeprefix(root)}", "relation": "mentions", "confidence": "EXTRACTED",
                          "score": 1.0, "origin": "claude-mem"})
    return nodes, edges
