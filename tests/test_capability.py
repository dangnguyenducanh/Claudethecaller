import json
from pathlib import Path

from ctc.ingestion.scanner import default_roots, scan_library


def _write_skill(root: Path, name: str, description: str = "does a thing", body: str = "Body text.") -> Path:
    skill_dir = root / "skills" / name
    skill_dir.mkdir(parents=True)
    path = skill_dir / "SKILL.md"
    path.write_text(f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n", encoding="utf-8")
    return path


def test_same_skill_name_in_two_namespaces_gets_distinct_ids(tmp_path):
    p1 = tmp_path / "p1"
    p2 = tmp_path / "p2"
    _write_skill(p1, "review")
    _write_skill(p2, "review")

    caps, warnings = scan_library([(p1, "p1"), (p2, "p2")])

    ids = {c.id for c in caps}
    assert "p1:review" in ids
    assert "p2:review" in ids
    assert warnings == []


def test_invalid_yaml_falls_back_to_lenient_parse_and_no_description_is_skipped(tmp_path):
    # Claude Code loads frontmatter that strict YAML rejects (e.g. an unquoted "Triggers on: ..."), so the scanner does too.
    root = tmp_path / "plugin"
    good_path = _write_skill(root, "good")
    lenient_dir = root / "skills" / "lenient"
    lenient_dir.mkdir(parents=True)
    (lenient_dir / "SKILL.md").write_text(
        "---\nname: lenient\ndescription: Use it. Triggers on: x, y\n---\nBody\n", encoding="utf-8"
    )
    empty_dir = root / "skills" / "empty"
    empty_dir.mkdir(parents=True)
    empty_path = empty_dir / "SKILL.md"
    empty_path.write_text("---\nname: empty\n---\nBody\n", encoding="utf-8")

    caps, warnings = scan_library([(root, "plugin")])

    by_name = {c.name: c for c in caps}
    assert set(by_name) == {"good", "lenient"} and by_name["good"].path == str(good_path)
    assert by_name["lenient"].description == "Use it. Triggers on: x, y"
    assert len(warnings) == 1 and str(empty_path) in warnings[0]


def test_plugin_json_declared_paths_are_scanned_and_undeclared_dirs_are_not(tmp_path):
    root = tmp_path / "cache" / "m" / "p" / "1.0.0"
    manifest_dir = root / ".claude-plugin"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps({"name": "p", "agents": ["./a.md"], "skills": "./skills/"}),
        encoding="utf-8",
    )
    (root / "a.md").write_text(
        "---\nname: a\ndescription: an agent\n---\n\nBody.\n", encoding="utf-8"
    )
    _write_skill(root, "s")
    # decoy: not declared in plugin.json and not matching an anchored root glob
    _write_skill(root / "docs" / "ja-JP", "x")

    caps, warnings = scan_library([(root, "p")])

    ids = {c.id for c in caps}
    assert "p:a" in ids
    assert len([c for c in caps if c.id == "p:s"]) == 1
    assert warnings == []
    assert not any("docs" in c.path for c in caps)


def test_duplicate_id_across_kinds_keeps_highest_priority_kind(tmp_path):
    root = tmp_path / "p1"
    skill_path = _write_skill(root, "x")
    commands_dir = root / "commands"
    commands_dir.mkdir(parents=True)
    command_path = commands_dir / "x.md"
    command_path.write_text("---\nname: x\ndescription: a command\n---\n\nBody.\n", encoding="utf-8")

    caps, warnings = scan_library([(root, "p1")])

    matches = [c for c in caps if c.id == "p1:x"]
    assert len(matches) == 1
    assert matches[0].kind == "skill"
    assert matches[0].path == str(skill_path)
    assert len(warnings) == 1
    assert str(skill_path) in warnings[0] and str(command_path) in warnings[0]


def test_two_project_dirs_get_distinct_namespaced_ids(tmp_path):
    proj_a = tmp_path / "a"
    proj_b = tmp_path / "b"
    _write_skill(proj_a / ".claude", "review")
    _write_skill(proj_b / ".claude", "review")

    caps_a, _ = scan_library([(proj_a / ".claude", f"project@{'a'}")])
    caps_b, _ = scan_library([(proj_b / ".claude", f"project@{'b'}")])

    cap_a = next(c for c in caps_a if c.name == "review")
    cap_b = next(c for c in caps_b if c.name == "review")
    assert cap_a.id != cap_b.id

    roots_a = default_roots(proj_a)
    roots_b = default_roots(proj_b)
    project_namespace_a = next(ns for root, ns in roots_a if root == proj_a / ".claude")
    project_namespace_b = next(ns for root, ns in roots_b if root == proj_b / ".claude")
    assert project_namespace_a.startswith("project@")
    assert project_namespace_a != project_namespace_b


def test_invoke_is_bare_name_for_user_and_project_else_the_id(tmp_path):
    user_root = tmp_path / "home"
    _write_skill(user_root, "review")
    user_cap = next(c for c in scan_library([(user_root, "user")])[0] if c.name == "review")
    assert user_cap.invoke == "review"

    project_root = tmp_path / "proj"
    _write_skill(project_root, "review")
    project_cap = next(
        c for c in scan_library([(project_root, "project@abcd1234")])[0] if c.name == "review"
    )
    assert project_cap.invoke == "review"

    plugin_root = tmp_path / "p1"
    _write_skill(plugin_root, "review")
    plugin_cap = next(c for c in scan_library([(plugin_root, "p1")])[0] if c.name == "review")
    assert plugin_cap.invoke == "p1:review"
