"""US15: an editor save carries the file hash it loaded; the daemon refuses (409 changed_on_disk) to overwrite a file
that changed on disk since. API tests through FastAPI's TestClient, no DB."""

import hashlib
from types import SimpleNamespace

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ctc.server import library

GRAPH = {"nodes": [{"id": "start", "type": "trigger"}, {"id": "x", "type": "shell", "command": "true"}],
         "edges": [{"from": "start", "to": "x"}]}


def sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def api(tmp_path, monkeypatch):
    """(client, wf): a user-scope workflow file under tmp_path and a client for the library router."""
    wf = tmp_path / "ctc-workflows" / "demo.yaml"
    wf.parent.mkdir()
    wf.write_text(yaml.safe_dump({"name": "demo", "description": "demo", **GRAPH}, sort_keys=False))
    app = FastAPI()
    app.include_router(library.router)
    app.state.st = SimpleNamespace(cfg={"mode": "local", "claude_home": str(tmp_path)}, store=SimpleNamespace(catalog={
        "user:demo": {"id": "user:demo", "path": str(wf), "kind": "workflow", "namespace": "user"}}))

    async def reindex(*a):
        pass

    async def cap(st, u, cap_id, pid=None):
        return {"id": cap_id, "kind": "workflow", "namespace": "user", "description": "demo", "override": None,
                "calls_30d": 0, "followed_30d": 0, "cluster_id": None}
    monkeypatch.setattr(library, "_reindex", reindex)
    monkeypatch.setattr(library, "_cap", cap)
    return TestClient(app), wf


def patch(client, body):
    return client.patch("/api/capabilities/user:demo", json=body)


def test_save_after_an_on_disk_edit_is_refused(api):
    client, wf = api
    h0 = sha(wf)
    wf.write_text(wf.read_text() + "# hand edit\n")
    edited = wf.read_bytes()
    r = patch(client, {"graph": GRAPH, "base_hash": h0})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "changed_on_disk"
    assert wf.read_bytes() == edited


def test_save_after_the_file_was_deleted_is_refused(api):
    client, wf = api
    h0 = sha(wf)
    wf.unlink()
    r = patch(client, {"graph": GRAPH, "base_hash": h0})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "changed_on_disk"
    assert not wf.exists()


def test_save_with_a_matching_hash_writes_and_returns_the_new_hash(api):
    client, wf = api
    h0 = sha(wf)
    g = {"nodes": GRAPH["nodes"] + [{"id": "y", "type": "shell", "command": "echo hi"}],
         "edges": GRAPH["edges"] + [{"from": "x", "to": "y"}]}
    r = patch(client, {"graph": g, "base_hash": h0})
    assert r.status_code == 200, r.text
    assert "y" in [n["id"] for n in yaml.safe_load(wf.read_text())["nodes"]]
    assert r.json()["file_hash"] == sha(wf) != h0


def test_save_without_base_hash_still_overwrites(api):
    client, wf = api
    wf.write_text(wf.read_text() + "# hand edit\n")
    r = patch(client, {"graph": GRAPH})
    assert r.status_code == 200, r.text
    assert "# hand edit" not in wf.read_text()
