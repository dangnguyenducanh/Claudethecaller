from pathlib import Path

from ctc.capability import scan_library


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


def test_broken_frontmatter_is_skipped_with_one_warning(tmp_path):
    root = tmp_path / "plugin"
    good_path = _write_skill(root, "good")
    broken_dir = root / "skills" / "broken"
    broken_dir.mkdir(parents=True)
    broken_path = broken_dir / "SKILL.md"
    broken_path.write_text(
        "---\nname: broken\ndescription: [unterminated\n---\nBody\n",
        encoding="utf-8",
    )

    caps, warnings = scan_library([(root, "plugin")])

    assert {c.path for c in caps} == {str(good_path)}
    assert len(warnings) == 1
    assert str(broken_path) in warnings[0]
