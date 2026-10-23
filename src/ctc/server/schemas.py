"""/api response and request models: dashboard/src/types.ts field for field (PLAN.md "API design").

`pnpm -C dashboard gen:types` regenerates the dashboard's types from /openapi.json, so these are the source of truth.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ctc.decision.bundle import StageRow, Step

Range = Literal["7d", "30d", "90d", "all"]
Metric = Literal["calls", "adoption", "latency"]
Kind = Literal["skill", "agent", "command", "workflow"]
Override = Literal["pin", "block", "disable"]
MemoryKind = Literal["preference", "convention", "fact", "skill_outcome"]
Scope = Literal["global", "project"]
Source = Literal["hook", "history"]  # live hooks vs imported Claude history (B9)
KPI_KEYS = ("routing_calls", "adoption_rate", "lazy_misses", "p95_ms")


class Ok(BaseModel):
    ok: Literal[True] = True


class Project(BaseModel):
    id: str
    name: str
    sessions: int


class ProjectDetail(Project):
    path: str
    decisions: int
    memories: int
    overrides: int
    last_active: datetime | None


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class KpiDelta(BaseModel):  # KPI_KEYS -> change vs the previous window (fraction); None for range=all
    routing_calls: float | None
    adoption_rate: float | None
    lazy_misses: float | None
    p95_ms: float | None


class KpiSpark(BaseModel):  # KPI_KEYS -> one value per day
    routing_calls: list[float]
    adoption_rate: list[float]
    lazy_misses: list[float]
    p95_ms: list[float]


class Kpis(BaseModel):
    routing_calls: float
    adoption_rate: float  # 0..1, followed / non-abstained
    lazy_misses: float  # non-abstained - followed
    p95_ms: float
    delta: KpiDelta
    spark: KpiSpark


class Series(BaseModel):
    project: str
    values: list[float]


class Timeline(BaseModel):
    days: list[str]
    series: list[Series]


class Decision(BaseModel):
    id: int
    at: datetime
    session_id: str
    project: str
    prompt: str
    abstained: bool
    followed: bool
    latency_ms: float
    difficulty: str
    model_tier: str
    confidence: float
    steps: list[Step]
    stages: list[StageRow]
    source: Source  # history rows store the distilled intent as `prompt`, never the raw text


class DayCount(BaseModel):
    day: str
    count: int


class Activity(BaseModel):
    days: list[DayCount]  # last 84 days, oldest first
    active_days: int
    streak: int
    longest_streak: int
    busiest: DayCount
    per_active_day: float


class WorkflowStep(BaseModel):
    cap: str
    agent: str | None = None


class WfNode(BaseModel):  # node fields: PLAN.md m5 "Workflow file"; ctc.runner.graph.validate checks them
    model_config = ConfigDict(extra="allow")
    id: str
    type: str  # trigger | agent | shell | if | approval (M2)
    pos: list[int | float] = [0, 0]


class WfEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: str = Field(alias="from")
    to: str
    handle: str | None = None  # an IF's "true" | "false"

    @field_validator("handle", mode="before")
    @classmethod
    def _yaml_bool(cls, v):  # YAML reads `handle: true` as a bool
        return str(v).lower() if isinstance(v, bool) else v


class Graph(BaseModel):
    model_config = ConfigDict(extra="allow")  # a run's snapshot also carries the file's name, settings, defaults
    nodes: list[WfNode]
    edges: list[WfEdge]


class WorkflowSettings(BaseModel):
    permission: Literal["worktree", "container"] = "worktree"  # container: agent nodes run in the ctc-runner image (M6)
    allow_extra_usage: bool = False
    auto_resume: bool = True
    max_run_tokens: int | None = Field(default=None, ge=1)


class ScheduleSet(BaseModel):  # PUT /api/workflows/{cap_id}/schedule
    cron: str  # min hour dom mon dow, daemon local time; 422 bad_cron
    input: str = ""
    enabled: bool = True


class Schedule(BaseModel):  # GET /api/capabilities/{id} .schedule; PUT …/schedule returns it
    cron: str
    input: str
    enabled: bool
    next_at: datetime | None  # the next slot (in the past while a fire is held); null when disabled
    last_fired_at: datetime | None  # the latest slot handled (fired, or skipped while no daemon ran)


class Capability(BaseModel):
    id: str
    kind: Kind
    namespace: str
    description: str
    override: Override | None
    calls_30d: int
    followed_30d: int
    cluster_id: str | None


class CapabilityDetail(Capability):
    name: str
    invoke: str
    path: str
    body: str
    summary: str | None
    triggers: list[str]
    editable: bool
    vectors: int
    cluster_members: list[str]
    recent_decisions: list[Decision]
    steps: list[WorkflowStep] | None = None  # workflows only
    graph: Graph | None = None  # workflows saved with a graph
    settings: WorkflowSettings | None = None  # workflows only
    schedule: Schedule | None = None  # workflows with a schedule (local mode, this login's)


class NewCapability(BaseModel):
    kind: Kind
    scope: Literal["user", "project"]
    project: str | None = None
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    description: str = Field(min_length=1, max_length=2000)
    body: str | None = None
    steps: list[WorkflowStep] | None = None
    graph: Graph | None = None  # workflows: replaces steps (they are derived from its agent nodes)
    settings: WorkflowSettings | None = None


class CapabilityPatch(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    body: str | None = None
    steps: list[WorkflowStep] | None = None
    graph: Graph | None = None
    settings: WorkflowSettings | None = None


class OverrideSet(BaseModel):
    project: str | None = None
    action: Override | None = None


class DedupPair(BaseModel):
    id: int
    a: str
    b: str
    similarity: float
    status: Literal["open", "merged", "kept_apart"]


class DedupResolve(BaseModel):
    action: Literal["merge", "keep_apart"]


class Session(BaseModel):
    id: str
    project: str
    title: str
    model: str
    started_at: datetime
    turns: int
    tokens: int
    decisions: int
    followed: int
    memories: int
    source: Source
    summary: str | None
    status: Literal["pending", "processed", "failed"]
    git_branch: str | None


class Memory(BaseModel):
    id: str
    scope: Scope
    project: str | None
    kind: MemoryKind
    text: str
    confidence: float
    pinned: bool
    use_count: int
    updated_at: datetime
    source: str  # "claude-memory · <file>" | "session <id>" | "history · <cap_id>" | "manual"
    supersedes: str | None  # "<id> (<first 40 chars of its text>)"
    deleted_at: datetime | None = None


class SessionDetail(BaseModel):  # types.ts: Session minus its counts, plus the arrays
    id: str
    project: str
    title: str
    model: str
    started_at: datetime
    turns: int
    tokens: int
    followed: int
    source: Source
    summary: str | None
    status: Literal["pending", "processed", "failed"]
    git_branch: str | None
    decisions: list[Decision]
    memories: list[Memory]


class MemoryDetail(Memory):
    history: list[Memory]


class NewMemory(BaseModel):
    scope: Scope
    project: str | None = None
    kind: MemoryKind
    text: str = Field(min_length=1, max_length=4000)
    pinned: bool = False


class MemoryPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    pinned: bool | None = None
    kind: MemoryKind | None = None
    scope: Scope | None = None


class MemoryWrite(BaseModel):
    action: Literal["ADD", "UPDATE", "NOOP"]  # SUPERSEDE never comes from the API (no `supersedes` in NewMemory)
    memory: Memory


class Job(BaseModel):
    id: str
    kind: str
    status: Literal["queued", "running", "done", "failed"]
    progress: float
    result: dict | None
    error: str | None
    created_at: datetime


class JobRef(BaseModel):
    job_id: str


class HistoryStatus(BaseModel):
    root: str
    files: int  # main transcripts on disk
    imported: int
    pending: int
    processed: int
    failed: int
    last_job: Job | None


class HistoryFile(BaseModel):
    path: str
    session_id: str | None
    size: int
    status: str
    error: str | None
    imported_at: datetime | None


class HistoryImport(BaseModel):
    process: bool = True
    projects: list[str] | None = None


class IndexRequest(BaseModel):
    project: str | None = None


class BackfillRequest(BaseModel):
    sessions: int = Field(default=20, ge=1, le=500)


class ImportRequest(BaseModel):
    dirs: list[str] | None = None


class ApiKey(BaseModel):
    id: int
    name: str
    created_at: datetime
    revoked_at: datetime | None
    key: str | None = None  # only on create, shown once


RunStatus = Literal["queued", "running", "waiting", "done", "failed", "cancelled", "quota"]
RunTrigger = Literal["button", "cli", "api", "schedule", "mcp"]


class RunStart(BaseModel):
    input: str = ""
    project: str | None = None  # a user or plugin workflow runs in this project (name); a project workflow in its own
    trigger: RunTrigger = "api"


class RunRef(BaseModel):
    run_id: int


class WorkflowExport(BaseModel):  # POST /api/workflows/{cap_id}/export
    path: str  # the written <root>/.claude/workflows/<name>.js


class RunApprove(BaseModel):
    approve: bool
    note: str | None = None


class RunContinue(BaseModel):
    when: Literal["now", "reset"]  # now: queued at once; reset: auto_resume, queued once quota_resets_at passes


class Run(BaseModel):
    id: int
    workflow: str  # cap_id
    project: str | None
    status: RunStatus
    trigger: RunTrigger
    input: str
    branch: str | None
    worktree: str | None
    pr_url: str | None
    error: str | None
    quota_resets_at: datetime | None
    auto_resume: bool
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
    tokens: int
    nodes_done: int  # done or skipped
    nodes_total: int


class DiffFile(BaseModel):  # git numstat; None for binary files
    path: str
    added: int | None
    deleted: int | None


class Diff(BaseModel):
    diff: str  # first 64 KB
    files: list[DiffFile]
    truncated: bool


class RunStep(BaseModel):  # types.ts `Step` (that name is the router's bundle step here)
    id: int
    node_id: str
    visit: int
    kind: str
    status: Literal["running", "waiting", "done", "failed", "timeout", "cancelled", "quota", "skipped"]
    input: str | None
    output: dict | None
    error: str | None
    session_id: str | None
    num_turns: int | None
    tokens: dict[str, int] | None  # usage's *_tokens
    cost_usd: float | None  # notional on a subscription
    permission_denials: list | None
    overage: bool | None
    files: list[DiffFile] | None
    started_at: datetime
    ended_at: datetime | None


class RunDetail(Run):
    graph: Graph
    file_sha: str
    auth: dict | None  # {authMethod, email, claude_version}
    steps: list[RunStep]


class StepLog(BaseModel):
    text: str
    offset: int  # byte offset to ask for next
    done: bool


Svc = Literal["ok", "down"]


class Health(BaseModel):
    db: Svc
    redis: Svc
    embedder: Svc
    reranker: Svc
    llm: Svc
    library_version: str
    mode: Literal["local", "shared"]


class NewApiKey(BaseModel):
    name: str = Field(min_length=1, max_length=100)


# ---- row -> model (rows come from SQL that also selects the project's name as `project`) ----


def to_decision(r: dict) -> Decision:
    return Decision(**{k: r[k] for k in ("id", "at", "session_id", "project", "prompt", "abstained", "followed", "latency_ms",
                                         "difficulty", "model_tier", "confidence", "source")},
                    steps=r["bundle"].get("steps", []), stages=r["stages"] or [])


def memory_source(src: dict | None) -> str:
    src = src or {}
    if src.get("kind") == "claude-memory":
        return f"claude-memory · {src.get('file', '')}"
    if src.get("kind") == "session":
        return f"session {src.get('session_id', '')}"
    if src.get("kind") == "history-outcome":
        return f"history · {src.get('cap_id', '')}"
    return "manual"


def to_memory(r: dict) -> Memory:
    """`r` = a memories row + `project` (name or None) + `supersedes_text` (the superseded row's text or None)."""
    sup = f"{r['supersedes']} ({(r.get('supersedes_text') or '')[:40]})" if r.get("supersedes") else None
    return Memory(id=str(r["id"]), scope=r["scope"], project=r.get("project"), kind=r["kind"], text=r["text"],
                  confidence=r["confidence"], pinned=r["pinned"], use_count=r["use_count"], updated_at=r["updated_at"],
                  source=memory_source(r.get("source")), supersedes=sup, deleted_at=r.get("deleted_at"))
