"""Scan skills, agents, commands and workflows into namespaced Capability records."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml

Kind = Literal["skill", "agent", "command", "workflow"]

# (kind, glob relative to a root, name comes from the matched dir instead of the file stem)
_GLOBS: list[tuple[Kind, str, bool]] = [
    ("skill", "skills/*/SKILL.md", True),
    ("agent", "agents/*.md", False),
    ("command", "commands/*.md", False),
    ("workflow", "workflows/*.md", False),
    ("workflow", "workflows/*.yaml", False),
]


@dataclass(frozen=True)
class Capability:
    id: str
    kind: Kind
    name: str
    namespace: str
    description: str
    body: str
    path: str
    hash: str


def _split_frontmatter(text: str) -> tuple[dict, str] | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    header = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    try:
        data = yaml.safe_load(header)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    return data, body


def _make_capability(path: Path, kind: Kind, namespace: str, default_name: str) -> Capability | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    parsed = _split_frontmatter(text)
    if parsed is None:
        return None
    meta, body = parsed
    description = meta.get("description")
    if not isinstance(description, str) or not description.strip():
        return None
    raw_name = meta.get("name")
    name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else default_name
    digest = hashlib.sha256(f"{description}\n{body}".encode()).hexdigest()
    return Capability(
        id=f"{namespace}:{name}",
        kind=kind,
        name=name,
        namespace=namespace,
        description=description,
        body=body,
        path=str(path),
        hash=digest,
    )


def _scan_root(root: Path, namespace: str) -> tuple[list[Capability], list[str]]:
    caps: list[Capability] = []
    warnings: list[str] = []
    for kind, pattern, name_from_dir in _GLOBS:
        for path in sorted(root.glob(pattern)):
            default_name = path.parent.name if name_from_dir else path.stem
            cap = _make_capability(path, kind, namespace, default_name)
            if cap is None:
                warnings.append(f"skipped malformed capability file: {path}")
                continue
            caps.append(cap)
    return caps, warnings


def scan_library(roots: list[tuple[Path, str]]) -> tuple[list[Capability], list[str]]:
    caps: list[Capability] = []
    warnings: list[str] = []
    for root, namespace in roots:
        if not root.is_dir():
            continue
        root_caps, root_warnings = _scan_root(root, namespace)
        caps.extend(root_caps)
        warnings.extend(root_warnings)
    return caps, warnings


def default_roots(project_dir: Path) -> list[tuple[Path, str]]:
    home = Path.home()
    roots: list[tuple[Path, str]] = [(home / ".claude", "user")]

    installed = home / ".claude" / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(installed.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    for key, entries in data.get("plugins", {}).items():
        namespace = key.split("@", 1)[0]
        for entry in entries:
            install_path = entry.get("installPath")
            if install_path:
                roots.append((Path(install_path), namespace))

    roots.append((project_dir / ".claude", "project"))
    return roots


if __name__ == "__main__":
    import sys

    capabilities, scan_warnings = scan_library(default_roots(Path.cwd()))
    for warning in scan_warnings:
        print(warning, file=sys.stderr)
    print(len(capabilities))
