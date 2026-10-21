"""Bundle: search hits → workflow → ordered steps → agent, difficulty and model tier, plus the hook/MCP texts (PLAN.md B6)."""

from __future__ import annotations

import inspect
import logging
import textwrap
from functools import cache
from pathlib import Path

import joblib
import numpy as np
import yaml
from pydantic import BaseModel

from ctc.config import ROOT, cfg
from ctc.ingestion.scanner import _split_frontmatter, project_namespace
from ctc.retrieval.hybrid import Ctx, Hit, SearchResult

DIFFICULTY_PATH = ROOT / "models" / "difficulty.joblib"  # A2 writes {"difficulty": clf, "model_tier": clf}
PLAN_END = "Use these in order; say why if you skip one."
log = logging.getLogger(__name__)


class Step(BaseModel):
    order: int
    cap_id: str
    invoke: str
    kind: str
    agent: str | None = None
    reason: str


class StageRow(BaseModel):
    cap_id: str
    dense_rank: int | None
    sparse_rank: int | None
    rrf: float
    rerank: float | None
    dropped: str | None


class Bundle(BaseModel):
    ref: str = ""
    intent: str
    confidence: float = 0.0
    difficulty: str = "standard"
    model_tier: str = "sonnet"
    workflow: str | None = None
    steps: list[Step] = []
    memories: list[str] = []
    abstained: bool
    stages: list[StageRow] = []


@cache
def _difficulty_models() -> dict | None:
    # ponytail: loaded once per process; restart the daemon after A2 retrains.
    return joblib.load(DIFFICULTY_PATH) if DIFFICULTY_PATH.exists() else None


def _tiers(qv) -> tuple[str, str]:
    try:
        m = _difficulty_models()
        if m is not None and qv is not None:
            x = np.asarray(qv, dtype="float32").reshape(1, -1)
            return str(m["difficulty"].predict(x)[0]), str(m["model_tier"].predict(x)[0])
    except Exception:  # fail-open: a broken model file never blocks routing
        log.exception("difficulty model %s failed; using standard/sonnet", DIFFICULTY_PATH)
    return "standard", "sonnet"


def _rerank(h: Hit) -> float:
    return h.stages.get("rerank") or 0.0


def _reason(q: str, score: float, cap: dict) -> str:
    trigger = next((t for t in cap.get("triggers") or [] if t.lower() in q.lower()), None)
    return f"rerank {score:.4f} · {trigger or textwrap.shorten(cap['description'], 60, placeholder='…')}"


def _workflow_steps(path: str | None) -> list[dict]:
    """[{cap, agent?}] a workflow file declares; [] when it declares none or can't be read."""
    try:
        text = Path(path).read_text(encoding="utf-8")
        data = (_split_frontmatter(text) or (None,))[0] if path.endswith(".md") else next(yaml.safe_load_all(text), None)
        steps = data.get("steps") or []
        steps = [steps] if isinstance(steps, str) else steps if isinstance(steps, list) else []  # `steps: tdd` is one step
        return [s if isinstance(s, dict) else {"cap": s} for s in steps if isinstance(s, (dict, str))]
    except (OSError, ValueError, TypeError, AttributeError, yaml.YAMLError):  # fail-open: falls back to the workflow itself
        return []


def _lookup(get, name: str, namespace: str) -> dict | None:
    """A workflow names a step by id, or by short name within its own namespace."""
    for cap_id in (name, f"{namespace}:{name}"):
        try:
            return get(cap_id)
        except KeyError:
            pass
    return None


async def decide(q: str, res: SearchResult, ctx: Ctx, qv=None, memories: list[str] | None = None) -> Bundle:
    get = ctx.store.get
    difficulty, tier = _tiers(qv)
    p = getattr(res, "p", None)  # calibrated gate probability (K2) when the search sets one
    top = res.hits[0] if res.hits else None
    b = Bundle(intent=q, difficulty=difficulty, model_tier=tier, memories=memories or [], abstained=res.abstained or top is None,
               confidence=p if p is not None else min(max(_rerank(top), 0.0), 1.0) if top else 0.0, stages=stage_rows(res))
    if b.abstained:
        return b

    agents = [h for h in res.hits if get(h.cap_id)["kind"] == "agent" and _rerank(h) >= cfg()["agent_min_rerank"]]
    best = max(agents, key=_rerank, default=None)
    agent = get(best.cap_id)["invoke"] if best else None
    top_cap = get(top.cap_id)
    rows: list[tuple[dict, float, str | None]] = []  # (cap, score, agent)
    if top_cap["kind"] == "workflow":
        b.workflow = top_cap["invoke"]
        ns = top_cap["namespace"]
        # Declared steps never went through search's filters, so apply the same block/disable + other-project rules here.
        # ponytail: a second overrides() read on the workflow path; reuse search's dict if SearchResult ever carries it.
        ovr = ctx.store.overrides(ctx.project)
        ovr = await ovr if inspect.isawaitable(ovr) else ovr  # LocalStore is sync, the Postgres Store async
        own_ns = project_namespace(Path(ctx.project))
        ok = lambda c: ovr.get(c["id"]) not in ("block", "disable") and not (
            c.get("namespace", "").startswith("project@") and c["namespace"] != own_ns)
        named = lambda n: _lookup(get, n, ns) or {"id": n, "invoke": n, "kind": "skill", "description": top_cap["description"]}
        for s in _workflow_steps(top_cap.get("path")):
            cap, want = named(str(s["cap"])) if s.get("cap") else None, named(str(s["agent"])) if s.get("agent") else None
            if cap and ok(cap):
                rows.append((cap, _rerank(top), want["invoke"] if want and ok(want) else agent))
        rows = rows or [(top_cap, _rerank(top), agent)]
    else:
        rows = [(c, _rerank(h), agent) for h in res.hits if (c := get(h.cap_id))["kind"] in ("skill", "command")]
        rows = rows or ([(get(best.cap_id), _rerank(best), None)] if best else [])  # only agents fit: the best one is the step
    b.steps = [Step(order=i, cap_id=c["id"], invoke=c["invoke"], kind=c["kind"], agent=a, reason=_reason(q, s, c))
               for i, (c, s, a) in enumerate(rows, 1)]
    b.abstained = not b.steps  # nothing to suggest is an abstain, so KPIs never count it as a missed suggestion
    return b


def stage_rows(res: SearchResult) -> list[StageRow]:
    def row(h: Hit, why: str | None) -> StageRow:
        st = h.stages
        return StageRow(cap_id=h.cap_id, dense_rank=st.get("dense_rank"), sparse_rank=st.get("sparse_rank"),
                        rrf=st.get("rrf") or 0.0, rerank=st.get("rerank"), dropped=why)

    return [row(h, None) for h in res.considered] + [row(h, why) for h, why in res.dropped]


def suggestion_line(b: Bundle) -> str:
    if b.abstained or not b.steps:
        return ""
    invokes = ", ".join(dict.fromkeys(s.invoke for s in b.steps))
    return f'[claudethecaller] Suggested: {invokes} — call find_capabilities(ref="{b.ref}") for the plan'


def plan_text(b: Bundle) -> str:
    lines = [f"Workflow: {b.workflow}"] if b.workflow else []
    lines += [f"{s.order}. {s.invoke} ({s.kind}{f', with agent {s.agent}' if s.agent else ''}) — {s.reason}" for s in b.steps]
    lines = lines or ["No installed capability fits this task."]
    if b.memories:
        lines += ["", "Relevant memories:", *(f"- {m}" for m in b.memories)]
    return "\n".join([*lines, "", PLAN_END])


def followed(bundle: dict, tool_name: str, tool_input: dict) -> bool:
    key = {"Skill": "skill", "Agent": "subagent_type", "Task": "subagent_type"}.get(tool_name)
    name = (tool_input or {}).get(key) if key else None
    return bool(name) and any(name in (s.get("invoke"), s.get("cap_id"), s.get("agent")) for s in bundle.get("steps") or [])


if __name__ == "__main__":
    import asyncio
    import tempfile
    from types import SimpleNamespace

    from sklearn.dummy import DummyClassifier

    tmp = Path(tempfile.mkdtemp())
    (tmp / "ship.yaml").write_text("name: ship\ndescription: ship it\nsteps:\n  - cap: tdd\n  - cap: user:review\n    agent: pl:reviewer\n"
                                   "  - cap: unknown:thing\n    agent: helper\n")
    (tmp / "plain.md").write_text("---\ndescription: a plain workflow\n---\nDo the thing.\n")
    (tmp / "front.yaml").write_text("---\nname: front\ndescription: x\nsteps: [tdd]\n---\n")
    (tmp / "scalar.yaml").write_text("name: s\ndescription: d\nsteps: tdd\n")
    (tmp / "scalar.md").write_text("---\nname: s\ndescription: d\nsteps: tdd\n---\nbody\n")
    (tmp / "guard.yaml").write_text("steps:\n  - tdd\n  - project@deadbeef:local\n  - cap: review\n    agent: pl:reviewer\n")

    def cap(id, kind, desc, path="", triggers=()):
        ns, name = id.rsplit(":", 1)
        return {"id": id, "kind": kind, "name": name, "namespace": ns, "invoke": name if ns == "user" else id,
                "description": desc, "summary": None, "triggers": list(triggers), "cluster_id": None, "path": path, "hash": ""}

    caps = {c["id"]: c for c in [
        cap("user:tdd", "skill", "Write the failing test first, then the code that makes it pass, then refactor it."),
        cap("user:review", "skill", "Review a diff", triggers=["code review"]),
        cap("pl:deploy", "command", "Deploy to staging"),
        cap("pl:reviewer", "agent", "Reviewer subagent"),
        cap("user:ship", "workflow", "Ship a feature", str(tmp / "ship.yaml")),
        cap("user:plain", "workflow", "A plain workflow", str(tmp / "plain.md")),
        cap("user:front", "workflow", "Frontmatter yaml", str(tmp / "front.yaml")),
        cap("user:scalar", "workflow", "Scalar steps", str(tmp / "scalar.yaml")),
        cap("user:scalarmd", "workflow", "Scalar steps md", str(tmp / "scalar.md")),
        cap("user:guard", "workflow", "Filtered steps", str(tmp / "guard.yaml")),
        cap("project@deadbeef:local", "skill", "Another project's skill"),
    ]}
    ovr: dict[str, str] = {}
    ctx = Ctx(SimpleNamespace(get=caps.__getitem__, overrides=lambda project: ovr), None, None, str(tmp))
    hit = lambda id, rr, dr=1: Hit(id, 0.03, {"dense_rank": dr, "sparse_rank": None, "rrf": 0.0164, "rerank": rr})
    sr = lambda hits, dropped=(), abstained=False: SearchResult(hits, abstained, {}, list(dropped), hits)
    run = lambda q, res, **kw: asyncio.run(decide(q, res, ctx, **kw))

    # skill path: skills + commands in score order, agents are not steps, agent below threshold not attached
    res = sr([hit("user:tdd", 0.9), hit("pl:reviewer", 0.3, 2), hit("pl:deploy", 0.4, 3)], [(hit("user:old", None, 9), "blocked in this project")])
    b = run("add a test", res, memories=["prefers pytest"])
    assert [(s.order, s.invoke, s.kind, s.agent) for s in b.steps] == [(1, "tdd", "skill", None), (2, "pl:deploy", "command", None)], b.steps
    assert b.steps[0].reason == "rerank 0.9000 · Write the failing test first, then the code that makes it…", b.steps[0].reason
    assert (b.confidence, b.difficulty, b.model_tier, b.workflow, b.abstained) == (0.9, "standard", "sonnet", None, False)
    # stage_rows: every considered hit + every dropped candidate with its reason
    assert [(r.cap_id, r.dropped) for r in b.stages] == [("user:tdd", None), ("pl:reviewer", None), ("pl:deploy", None),
                                                         ("user:old", "blocked in this project")], b.stages
    assert b.stages[-1].rerank is None and b.stages[0].dense_rank == 1 and b.stages[0].rrf == 0.0164
    b.ref = "ab12cd34"
    assert suggestion_line(b) == '[claudethecaller] Suggested: tdd, pl:deploy — call find_capabilities(ref="ab12cd34") for the plan'
    pt = plan_text(b)
    assert pt.startswith("1. tdd (skill) — rerank 0.9000") and "- prefers pytest" in pt and pt.endswith(PLAN_END), pt

    # agent threshold on: best agent by rerank (>= agent_min_rerank) attached to every step; matched trigger as the reason
    b = run("do a code review", sr([hit("user:review", 0.8), hit("pl:reviewer", 0.7, 2), hit("user:tdd", 0.2, 3)]))
    assert [(s.invoke, s.agent) for s in b.steps] == [("review", "pl:reviewer"), ("tdd", "pl:reviewer")], b.steps
    assert b.steps[0].reason == "rerank 0.8000 · code review"

    # workflow yaml: declared steps in order; known caps resolved (short name in the workflow's namespace), unknown -> skill
    b = run("ship it", sr([hit("user:ship", 0.6), hit("pl:reviewer", 0.9, 2)]))
    assert b.workflow == "ship"
    assert [(s.cap_id, s.invoke, s.kind, s.agent) for s in b.steps] == [
        ("user:tdd", "tdd", "skill", "pl:reviewer"), ("user:review", "review", "skill", "pl:reviewer"),
        ("unknown:thing", "unknown:thing", "skill", "helper")], b.steps
    # declared agents stay without an agent hit; undeclared steps get none
    assert [s.agent for s in run("x", sr([hit("user:ship", 0.6)])).steps] == [None, "pl:reviewer", "helper"]
    # .md without steps -> the workflow itself; frontmatter-wrapped yaml with string steps
    assert [(s.cap_id, s.kind) for s in run("x", sr([hit("user:plain", 0.5)])).steps] == [("user:plain", "workflow")]
    assert [s.cap_id for s in run("x", sr([hit("user:front", 0.5)])).steps] == ["user:tdd"]

    # scalar `steps: tdd` (yaml and .md frontmatter) is one step, not one per character
    assert [s.cap_id for s in run("x", sr([hit("user:scalar", 0.5)])).steps] == ["user:tdd"]
    assert [s.cap_id for s in run("x", sr([hit("user:scalarmd", 0.5)])).steps] == ["user:tdd"]

    # declared steps/agents obey the search filters: disabled step and other-project step skipped, blocked agent not attached
    assert [(s.cap_id, s.agent) for s in run("x", sr([hit("user:guard", 0.6)])).steps] == [("user:tdd", None), ("user:review", "pl:reviewer")]
    ovr.update({"user:tdd": "disable", "pl:reviewer": "block"})
    assert [(s.cap_id, s.agent) for s in run("x", sr([hit("user:guard", 0.6)])).steps] == [("user:review", None)]
    async def aovr(project):  # the Postgres Store's overrides() is async
        return {"user:review": "block"}
    actx = Ctx(SimpleNamespace(get=caps.__getitem__, overrides=aovr), None, None, str(tmp))
    b = asyncio.run(decide("x", sr([hit("user:guard", 0.6)]), actx))
    assert [s.cap_id for s in b.steps] == ["user:tdd"], b.steps
    ovr.update({"user:review": "disable"})  # every declared step filtered -> the workflow itself
    assert [s.cap_id for s in run("x", sr([hit("user:guard", 0.6)])).steps] == ["user:guard"]
    ovr.clear()

    # only agents hit: the best agent above the threshold is the single step; below it the bundle abstains
    b = run("review my diff", sr([hit("pl:reviewer", 0.9)]))
    b.ref = "r"
    assert (b.abstained, [(s.cap_id, s.kind, s.agent) for s in b.steps]) == (False, [("pl:reviewer", "agent", None)]), b
    assert suggestion_line(b) == '[claudethecaller] Suggested: pl:reviewer — call find_capabilities(ref="r") for the plan'
    assert followed(b.model_dump(), "Agent", {"subagent_type": "pl:reviewer"})
    b = run("review my diff", sr([hit("pl:reviewer", 0.3)]))
    assert b.abstained and not b.steps and suggestion_line(b) == "" and plan_text(b).endswith(PLAN_END), b

    # abstained: no steps, empty suggestion, plan still ends with the instruction; gate probability wins as confidence
    res = sr([], abstained=True)
    res.considered = [hit("user:tdd", 0.01)]
    res.p = 0.12
    b = run("thanks!", res)
    assert b.abstained and not b.steps and b.confidence == 0.12 and suggestion_line(b) == "" and len(b.stages) == 1
    assert plan_text(b).endswith(PLAN_END)

    # difficulty model present: predicted from qv
    DIFFICULTY_PATH = tmp / "difficulty.joblib"
    x, y = np.zeros((2, 4)), [0, 1]
    joblib.dump({"difficulty": DummyClassifier(strategy="constant", constant="hard").fit(x, ["hard", "easy"]),
                 "model_tier": DummyClassifier(strategy="constant", constant="opus").fit(x, ["opus", "haiku"])}, DIFFICULTY_PATH)
    _difficulty_models.cache_clear()
    b = run("refactor the scheduler", sr([hit("user:tdd", 0.9)]), qv=np.ones(4))
    assert (b.difficulty, b.model_tier) == ("hard", "opus"), b
    assert run("x", sr([hit("user:tdd", 0.9)])).difficulty == "standard"  # no qv -> default

    # follow tracking
    bd = run("ship it", sr([hit("user:ship", 0.6), hit("pl:reviewer", 0.9, 2)])).model_dump()
    assert followed(bd, "Skill", {"skill": "tdd"}) and followed(bd, "Skill", {"skill": "user:review"})
    assert followed(bd, "Agent", {"subagent_type": "pl:reviewer"}) and followed(bd, "Task", {"subagent_type": "pl:reviewer"})
    assert not followed(bd, "Bash", {"command": "tdd"}) and not followed(bd, "Skill", {"skill": "other"}) and not followed(bd, "Skill", {})
    print("ok")
