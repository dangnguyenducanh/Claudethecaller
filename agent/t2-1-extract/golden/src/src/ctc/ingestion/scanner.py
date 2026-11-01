"""Scan skills, agents, commands and workflows into namespaced Capability records."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml

from ctc.config import cfg

Kind = Literal["skill", "agent", "command", "workflow"]

# (kind, glob relative to a root, name comes from the matched dir instead of the file stem)
_GLOBS: list[tuple[Kind, str, bool]] = [
    ("skill", "skills/*/SKILL.md", True),
    ("agent", "agents/*.md", False),
    ("command", "commands/*.md", False),
    ("workflow", "ctc-workflows/*.yaml", False),  # the runner's graphs (PLAN.md m5); first, so they win a name clash
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

    @property
    def invoke(self) -> str:
        if self.namespace == "user" or self.namespace.startswith("project@"):
            return self.name
        return self.id


def _split_frontmatter(text: str, lenient: bool = False) -> tuple[dict, str] | None:
    """YAML header + body. `lenient` falls back to flat strings (only for name/description, never typed keys like steps)."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    header = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    try:
        data = yaml.safe_load(header)
    except (yaml.YAMLError, ValueError, RecursionError):  # ValueError: bad dates (2024-13-45); deep nesting
        data = None
    if isinstance(data, dict):
        return data, body
    return (_lenient_frontmatter(header), body) if lenient else None


def _lenient_frontmatter(header: str) -> dict[str, str]:
    """Headers YAML rejects but Claude Code loads, e.g. an unquoted `Triggers on: ...` inside a description."""
    # ponytail: flat `key: value` + indented continuation only; no lists/block scalars (yaml handles those when valid)
    data: dict[str, str] = {}
    key = None
    for line in header.splitlines():
        if line[:1].isspace():
            if key is not None:
                data[key] = f"{data[key]} {line.strip()}".strip()
            continue
        k, sep, v = (line.rstrip() + " ").partition(": ")
        if sep:
            key = k.strip()
            data[key] = v.strip()
    return {k: v[1:-1] if len(v) > 1 and v[0] == v[-1] and v[0] in "'\"" else v for k, v in data.items()}


def _make_capability(path: Path, kind: Kind, namespace: str, default_name: str) -> Capability | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:  # dangling symlink, no permission, deleted mid-scan
        return None
    parsed = _split_frontmatter(text, lenient=True)
    plain = parsed is None and path.suffix == ".yaml"  # ctc-workflows/*.yaml: one YAML mapping, no frontmatter or body
    if plain:
        try:
            data = yaml.safe_load(text)
        except (yaml.YAMLError, ValueError, RecursionError):
            data = None
        parsed = (data, "") if isinstance(data, dict) else None
    if parsed is None:
        return None
    meta, body = parsed
    description = meta.get("description")
    if not isinstance(description, str) or not description.strip():
        return None
    raw_name = meta.get("name")
    name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else default_name
    digest = hashlib.sha256((text if plain else f"{description}\n{body}").encode()).hexdigest()  # plain: a graph edit is a change
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


_MANIFEST_PATH = ".claude-plugin/plugin.json"
_MANIFEST_KEY_KIND: dict[str, Kind] = {"skills": "skill", "agents": "agent", "commands": "command"}


def _load_plugin_manifest(root: Path) -> dict | None:
    try:
        data = json.loads((root / _MANIFEST_PATH).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _scan_declared_path(path: Path, kind: Kind, namespace: str) -> tuple[list[Capability], list[str]]:
    caps: list[Capability] = []
    warnings: list[str] = []
    if path.is_dir():
        pattern = "*/SKILL.md" if kind == "skill" else "*.md"
        for sub in sorted(path.glob(pattern)):
            default_name = sub.parent.name if kind == "skill" else sub.stem
            cap = _make_capability(sub, kind, namespace, default_name)
            if cap is None:
                warnings.append(f"skipped malformed capability file: {sub}")
                continue
            caps.append(cap)
    elif path.is_file():
        cap = _make_capability(path, kind, namespace, path.stem)
        if cap is None:
            warnings.append(f"skipped malformed capability file: {path}")
        else:
            caps.append(cap)
    return caps, warnings


def _scan_manifest_paths(root: Path, namespace: str) -> tuple[list[Capability], list[str]]:
    manifest = _load_plugin_manifest(root)
    if manifest is None:
        return [], []
    caps: list[Capability] = []
    warnings: list[str] = []
    for key, kind in _MANIFEST_KEY_KIND.items():
        declared = manifest.get(key)
        if declared is None:
            continue
        for rel in [declared] if isinstance(declared, str) else declared:
            if not isinstance(rel, str):
                continue
            sub_caps, sub_warnings = _scan_declared_path((root / rel).resolve(), kind, namespace)
            caps.extend(sub_caps)
            warnings.extend(sub_warnings)
    return caps, warnings


def _scan_root(root: Path, namespace: str) -> tuple[list[Capability], list[str]]:
    caps: list[Capability] = []
    warnings: list[str] = []
    seen_paths: set[Path] = set()
    for kind, pattern, name_from_dir in _GLOBS:
        for path in sorted(root.glob(pattern)):
            resolved = path.resolve()
            if resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            default_name = path.parent.name if name_from_dir else path.stem
            cap = _make_capability(path, kind, namespace, default_name)
            if cap is None:
                warnings.append(f"skipped malformed capability file: {path}")
                continue
            caps.append(cap)
    manifest_caps, manifest_warnings = _scan_manifest_paths(root, namespace)
    for cap in manifest_caps:
        resolved = Path(cap.path).resolve()
        if resolved in seen_paths:
            continue
        seen_paths.add(resolved)
        caps.append(cap)
    warnings.extend(manifest_warnings)
    return caps, warnings


_KIND_PRIORITY: dict[Kind, int] = {"skill": 0, "workflow": 1, "agent": 2, "command": 3}


def _dedup_by_id(caps: list[Capability]) -> tuple[list[Capability], list[str]]:
    by_id: dict[str, list[Capability]] = {}
    for cap in caps:
        by_id.setdefault(cap.id, []).append(cap)
    deduped: list[Capability] = []
    warnings: list[str] = []
    for cap_id, group in by_id.items():
        if len(group) == 1:
            deduped.append(group[0])
            continue
        kept = min(group, key=lambda c: _KIND_PRIORITY[c.kind])
        deduped.append(kept)
        other_paths = ", ".join(c.path for c in group if c is not kept)
        warnings.append(f"duplicate id {cap_id}: kept {kept.path}, dropped {other_paths}")
    return deduped, warnings


def scan_library(roots: list[tuple[Path, str]]) -> tuple[list[Capability], list[str]]:
    caps: list[Capability] = []
    warnings: list[str] = []
    for root, namespace in roots:
        if not root.is_dir():
            continue
        root_caps, root_warnings = _scan_root(root, namespace)
        caps.extend(root_caps)
        warnings.extend(root_warnings)
    caps, dedup_warnings = _dedup_by_id(caps)
    warnings.extend(dedup_warnings)
    return caps, warnings


def project_id(project_dir: Path | str) -> str:
    return hashlib.sha256(str(Path(project_dir).resolve()).encode()).hexdigest()[:8]


def project_namespace(project_dir: Path | str) -> str:
    return f"project@{project_id(project_dir)}"


def default_roots(project_dir: Path, claude_home: Path | None = None) -> list[tuple[Path, str]]:
    claude_home = claude_home or Path(cfg()["claude_home"])
    roots: list[tuple[Path, str]] = [(claude_home, "user")]

    installed = claude_home / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(installed.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    plugins = data.get("plugins") if isinstance(data, dict) else None
    for key, entries in (plugins if isinstance(plugins, dict) else {}).items():
        namespace = key.split("@", 1)[0]
        for entry in entries if isinstance(entries, list) else [entries]:  # v2: list per plugin, v1: one object
            install_path = entry.get("installPath") if isinstance(entry, dict) else None
            if isinstance(install_path, str) and install_path:
                roots.append((Path(install_path), namespace))

    roots.append((project_dir / ".claude", project_namespace(project_dir)))
    return roots


if __name__ == "__main__":
    import sys

    capabilities, scan_warnings = scan_library(default_roots(Path.cwd()))
    for warning in scan_warnings:
        print(warning, file=sys.stderr)
    print(len(capabilities))
