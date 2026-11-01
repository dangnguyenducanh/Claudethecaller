"""Writes the 006-merged-core graphs. Usage: python -I mk_svgs.py <out_dir>"""
import math
import sys
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(sys.argv[1])
C = {  # fill, stroke, text
    "gray": ("#F1EFE8", "#5F5E5A", "#2C2C2A"), "teal": ("#E1F5EE", "#0F6E56", "#04342C"),
    "purple": ("#EEEDFE", "#534AB7", "#26215C"), "coral": ("#FAECE7", "#993C1D", "#4A1B0C"),
    "blue": ("#E6F1FB", "#185FA5", "#042C53"), "amber": ("#FAEEDA", "#854F0B", "#412402"),
    "pink": ("#FBEAF0", "#993556", "#4B1528"),
}


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.p = w, h, []
        self.text(16, 26, title, 16, "#2C2C2A", bold=True, anchor="start")

    def text(self, x, y, s, size=12, color="#2C2C2A", bold=False, anchor="middle"):
        self.p.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" text-anchor="{anchor}" '
                      f'font-family="Helvetica, Arial, sans-serif"{" font-weight=\"bold\"" if bold else ""}>{escape(s)}</text>')

    def box(self, x, y, w, h, title, sub="", color="gray", dashed=False, rx=6, title_size=13):
        f, s, t = C[color]
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{f}" stroke="{s}" stroke-width="1"'
                      f'{" stroke-dasharray=\"5 4\"" if dashed else ""}/>')
        lines = sub.split("\n") if sub else []
        ty = y + h / 2 - 7 * len(lines) + (4 if not lines else 0)
        self.text(x + w / 2, ty, title, title_size, t, bold=True)
        for i, ln in enumerate(lines):
            self.text(x + w / 2, ty + 16 + 14 * i, ln, 11, s)

    def group(self, x, y, w, h, label, color="gray", dashed=False):
        f, s, t = C[color]
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="none" stroke="{s}" stroke-width="1"'
                      f'{" stroke-dasharray=\"6 4\"" if dashed else ""}/>')
        self.text(x + 10, y + 18, label, 12, t, bold=True, anchor="start")

    def arrow(self, pts, num=None, color="#444441", dashed=False, lx=None, ly=None):
        d = " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(pts))
        self.p.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.2"'
                      f'{" stroke-dasharray=\"5 4\"" if dashed else ""}/>')
        (x1, y1), (x2, y2) = pts[-2], pts[-1]
        a = math.atan2(y2 - y1, x2 - x1)
        pa = [(x2, y2), (x2 - 9 * math.cos(a - 0.4), y2 - 9 * math.sin(a - 0.4)), (x2 - 9 * math.cos(a + 0.4), y2 - 9 * math.sin(a + 0.4))]
        self.p.append(f'<polygon points="{" ".join(f"{px:.1f},{py:.1f}" for px, py in pa)}" fill="{color}"/>')
        if num is not None:
            if lx is None:
                (ax, ay), (bx, by) = pts[0], pts[1]
                lx, ly = (ax + bx) / 2, (ay + by) / 2
            self.p.append(f'<circle cx="{lx}" cy="{ly}" r="9" fill="#FFFFFF" stroke="{color}" stroke-width="1"/>')
            self.text(lx, ly + 4, str(num), 10, color, bold=True)

    def save(self, name):
        body = "\n".join(self.p)
        (OUT / name).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
                                f'viewBox="0 0 {self.w} {self.h}"><rect width="100%" height="100%" fill="#FFFFFF"/>\n{body}\n</svg>\n')


HOT, COLD = "#A32D2D", "#185FA5"
STAGES = ["Entry", "Logic", "Queue / process", "Side effects", "Storage"]


def lanes(title, rows, fname, dashed=False, stages=STAGES):
    s = Svg(1180, 70 + 76 * len(rows) + 20, title)
    for i, st in enumerate(stages):
        s.text(250 + i * 190, 58, st, 12, "#5F5E5A", bold=True)
    for li, (name, color, steps) in enumerate(rows):
        y = 70 + li * 76
        a0, *b0 = name.split("\n")
        s.text(20, y + 30, a0, 13, C[color][2], bold=True, anchor="start")
        if b0:
            s.text(20, y + 46, b0[0], 11, C[color][1], anchor="start")
        for si, st in enumerate(steps):
            x = 165 + si * 190
            s.box(x, y, 170, 60, "", "", color, dashed=dashed)
            a, b = st.split("\n")
            s.text(x + 85, y + 26, a, 11, C[color][2], bold=True)
            s.text(x + 85, y + 42, b, 11, C[color][1])
            if si:
                s.arrow([(x - 20, y + 30), (x, y + 30)])
    s.save(fname)


# Reference systems -----------------------------------------------------------------------------------------------
lanes("graphify 0.9.93: how it builds and serves a code graph", [
    ("Full build", "pink", ["/graphify skill,\ngraphify extract", "detect: classify,\n.gitignore, secrets", "process pool:\ntree-sitter per file", "cross-file calls,\ndedup, Louvain", "graph.json,\nreport, cache/"]),
    ("Incremental", "pink", ["git post-commit\nhook (detached)", "content-hash diff\nvs manifest.json", "re-extract changed +\nresolution context", "merge by file + tier,\nshrink guard", "graph.json\n(atomic write)"]),
    ("Query", "pink", ["graphify query,\nMCP query_graph", "label tiers + IDF,\npick <= 3 seeds", "BFS depth 2,\nhub cut-off", "render text,\n2000-token budget", "reads graph.json\n(hot reload)"]),
    ("Affected / path", "pink", ["graphify affected,\npath, explain", "resolve name;\nambiguous -> exit 3", "reverse BFS over\n15 relations", "directed shortest\npath", "reads\ngraph.json"]),
    ("Hook nudge", "pink", ["PreToolUse on\nBash/Grep/Read/Glob", "token-parse the\nsearch command", "cap 5 per session,\nquiet 30 min", "add <= 5 matching\nnodes as context", "fail open,\nexit 0"]),
], "src-graphify.svg")

lanes("Langfuse 4.72 (5cb2047): prompts and skills as a versioned library", [
    ("Create version", "teal", ["REST / tRPC / MCP\ncreate", "zod limits, parse\nfrontmatter or deps", "one Postgres tx +\nadvisory lock", "labels += latest;\nrotate cache epoch", "prompts / skills,\nskill_files, blobs"]),
    ("Move label", "teal", ["PATCH labels\n(production, ...)", "protected-label\nRBAC check", "SELECT FOR UPDATE,\nlabel off old versions", "EntityChange queue\n-> webhooks", "labels[] on the\nversion row"]),
    ("Resolve (read)", "teal", ["SDK get_prompt /\nMCP loadSkill", "default label\nproduction", "Redis key with\nproject epoch", "expand nested refs\n(depth 5)", "cache 1 h,\nfall back to DB"]),
    ("Serve skill files", "teal", ["getSkill ->\nmanifest + version", "loadSkillResource\n(version, path)", "content by sha256\n(10 MB batch)", "CLI install writes\nlockfile", "skill_blobs\n(content-addressed)"]),
    ("Trace linking", "teal", ["agent sends skills\navailable / loaded", "ingestion\nworker", "(name, version) -> id\nRedis cache", "skill analytics,\nlinked traces", "ClickHouse\nobservation cols"]),
], "src-langfuse.svg")

lanes("claude-mem 15.7 (325afb6): the memory loop", [
    ("Capture", "purple", ["PostToolUse, Stop,\nSessionEnd hooks", "strip private tags,\nskip rules", "write 1 spool file\nper event (atomic)", "nudge worker\n(250 ms, best effort)", "~/.claude-mem/\nhook-spool"]),
    ("Observe", "purple", ["worker drains spool\n(boot, watch, 30 s)", "RAM buffer, dedupe\nby tool_use_id", "Haiku observer\n(Agent SDK, no tools)", "XML parse; bad ->\nretry once, drop", "SQLite observations\n+ Chroma docs"]),
    ("Summarize", "purple", ["Stop hook\n(async)", "same observer\nconversation", "<summary> request,\nlearned, next_steps", "content hash\nON CONFLICT", "session_\nsummaries"]),
    ("Inject at start", "purple", ["SessionStart hook\n(60 s timeout)", "newest 50 obs +\nsummaries + work state", "fit by measuring:\n10,000-char cap", "drop narratives,\nthen older items", "stdout ->\nClaude context"]),
    ("Search (MCP)", "purple", ["search -> timeline\n-> get_observations", "Chroma top-N\n(100 -> 1600)", "SQLite hydrate +\nfilters", "server mode: RRF\nbm25 + HNSW, K=60", "ids index first,\nrows on request"]),
], "src-claude-mem.svg")

lanes("Orca 1.4.214 (2c4eb87): agents in git worktrees", [
    ("Create worktree", "amber", ["orca worktree create\n(RPC over socket)", "sanitize name,\nresolve base", "git worktree add\n--no-track -b (180 s)", "orca.yaml setup\nscript (120 s)", "branch.<b>.base\nconfig + app store"]),
    ("Launch agent", "amber", ["agent launch\n--prompt", "pick surface:\nterminal or chat", "PTY in terminal\ndaemon / SDK child", "prompt.outcome:\njournaled, handed..", "launch record\n(operationId)"]),
    ("Monitor status", "amber", ["managed hooks in\nthe agent config", "curl POST to\nloopback (token)", "status per pane:\nworking, blocked..", "OSC 7501 fallback\nafter 2 min", "status snapshot\n(7 d)"]),
    ("Orchestrate N", "amber", ["coordinator agent\n(an LLM)", "worker-start:\nTask + Dispatch txn", "worker sends\nworker_done once", "atomic settle; dup\nno-op, stale reject", "orchestration.db\n(SQLite v43)"]),
    ("Cleanup", "amber", ["worker-release,\nworktree rm", "archive hook\ngate", "close exact\nagent terminal", "git worktree remove;\nkeep branch", "removal\nrecords"]),
], "src-orca.svg")

# Merged target: feature flows ------------------------------------------------------------------------------------
lanes("006 target feature flows (dashed = not built): entry -> logic -> queue -> side effects -> storage", [
    ("Suggest per prompt\ngraph (graphify + ctc)", "pink", ["web /v1/hook/prompt\n(curl, 140 ms)", "seeds: lexical +\nembedding (+rerank)", "BFS depth 2 over\nRAM graph", "rank task, spec,\nskill, workflow", "1 line: task ->\nfile:sym, skill, decision"]),
    ("Build the graph\ngraphify", "pink", ["post-commit, edit\nhook, ctc graph build", "content-hash diff\nper file", "queue graph:\ntree-sitter + md parse", "resolve calls,\nshrink guard", "PG graph_nodes,\ngraph_edges"]),
    ("Version a skill\nLangfuse", "teal", ["scanner sees new\nfile hash", "advisory lock;\nversion = max + 1", "queue library:\nembed, enrich, dedup", "label latest;\nskill node in graph", "PG capability_versions,\ncap_files, cap_blobs"]),
    ("Learn a memory\nclaude-mem + ctc", "purple", ["Stop / SessionEnd\nhook -> spool file", "web drains spool\n-> queue llm", "llama-server: XML\nfacts + summary", "ADD / UPDATE / NOOP\n+ content hash", "PG memories,\nsession_summaries"]),
    ("Recall at start\nclaude-mem", "purple", ["web /v1/hook/start\n(SessionStart)", "RRF: tsvector +\npgvector, K = 60", "no queue\n(read path)", "fit 10,000 chars,\nfixed drop order", "context block\nto Claude"]),
    ("Run a workflow\nOrca", "amber", ["Workflows page,\nMCP run_workflow", "wf_runs queued;\nidempotency key", "queue runner:\nstep attempt + stage", "worktree + setup;\nclaude -p / codex", "PG wf_steps,\nrun logs, branch"]),
    ("Fan out\nOrca", "amber", ["fanout node in\na workflow", "N child steps,\ndepth limit 1", "BullMQ Flow\nchildren", "child worktree per\nstep, join merges", "PG wf_steps\n(attempts)"]),
], "flows-merged.svg", dashed=True)

# Merged target: application map ----------------------------------------------------------------------------------
s = Svg(1180, 560, "006: what ctc is for after the merge (surface, store); grey = removed")
groups = [
    ("Context graph (graphify + ctc)", "pink", [("Suggest per prompt", "POST /v1/hook/prompt", "RAM graph + Redis"),
                                               ("Notes before Read/Edit/Grep", "POST /v1/hook/pre", "RAM graph"),
                                               ("Search / explain / affected / path", "MCP graph_*, Graph page", "graph_nodes, graph_edges")]),
    ("Skill library (Langfuse)", "teal", [("Browse, version, label", "Library page, /api/capabilities", "capability_versions"),
                                         ("Load a skill and its files", "MCP get_capability, load_..", "cap_files, cap_blobs"),
                                         ("Pin per project", "PUT .../override (label)", "overrides")]),
    ("Memory (claude-mem + ctc)", "purple", [("Learn from sessions", "hooks -> spool -> queue llm", "memories, session_summaries"),
                                            ("Context at session start", "POST /v1/hook/start", "memories (RRF)"),
                                            ("Search memories", "MCP mem_search/timeline/get", "memories")]),
    ("Workflows (Orca)", "amber", [("Run a saved workflow", "Workflows page, MCP run_workflow", "wf_runs, wf_steps"),
                                   ("Approve with options", "POST /api/runs/:id/approve", "wf_steps.resolution"),
                                   ("Fan out, hand off, clean up", "fanout node, /api/runs/...", "worktrees, branches")]),
    ("Ops", "blue", [("Jobs and dead jobs", "Jobs page, /api/jobs", "jobs + BullMQ"),
                     ("API keys (shared mode)", "Keys page, /api/keys", "api_keys"),
                     ("Health", "GET /v1/health", "-")]),
    ("Removed in 006", "gray", [("Plan for a suggestion", "MCP find_capabilities, /v1/bundle", "bundle:{ref} cache"),
                                ("Follow tracking + adoption KPI", "hook/tool follow, /api/kpis", "decisions.followed"),
                                ("Route/decide pipeline", "/v1/route, bundle.decide", "decisions")]),
]
for gi, (name, color, items) in enumerate(groups):
    x, y = 20 + (gi % 3) * 385, 50 + (gi // 3) * 250
    s.group(x, y, 370, 235, name, color, dashed=(color == "gray"))
    for ii, (what, surface, store) in enumerate(items):
        s.box(x + 12, y + 30 + ii * 66, 346, 58, what, f"{surface}\nstore: {store}", color, dashed=(color == "gray"))
s.save("app-map-merged.svg")

# Merged target: architecture -------------------------------------------------------------------------------------
s = Svg(1180, 880, "006 target architecture (dashed = not built): TypeScript web + worker, Postgres + pgvector, Redis")
s.group(20, 50, 210, 500, "Clients")
s.box(35, 80, 180, 70, "Claude Code hooks", "prompt, pre: curl (reply)\ntool, start, stop", "gray")
s.box(35, 175, 180, 50, "Hook spool", "~/.claudethecaller/spool", "gray", dashed=True)
s.box(35, 250, 180, 50, "MCP client", "graph_*, skills, memory, run", "gray")
s.box(35, 325, 180, 50, "Dashboard", "React + Vite", "gray")
s.box(35, 400, 180, 50, "ctc CLI", "TS (commander)", "gray", dashed=True)
s.box(35, 475, 180, 50, "evaluation/ (Python)", "offline evals only", "gray")

s.group(260, 50, 300, 380, "apps/web: Fastify (socket + :18310)", "teal", dashed=True)
s.box(275, 80, 270, 60, "/v1/hook/prompt + pre", "graph suggest, file note (hot)", "pink", dashed=True)
s.box(275, 155, 270, 50, "/v1/hook/start", "memory context, 10,000 chars", "purple", dashed=True)
s.box(275, 220, 270, 50, "spool drain", "files -> BullMQ add", "teal", dashed=True)
s.box(275, 285, 270, 50, "/api + /mcp", "Zod schemas shared", "teal", dashed=True)
s.box(275, 350, 270, 60, "RAM graph + skill vectors", "reload on ctc:inval", "pink", dashed=True)

s.group(600, 50, 270, 380, "apps/worker: BullMQ queues", "teal", dashed=True)
for i, (q, sub, col) in enumerate([("graph", "tree-sitter, md, resolve", "pink"), ("library", "scan, version, embed, dedup", "teal"),
                                   ("llm (concurrency 1)", "enrich, memory extract + summary", "purple"),
                                   ("memory", "import files, distill history", "purple"), ("runner", "attempts, worktrees, fanout", "amber"),
                                   ("cleanup + dlq-retry", "worktree rm, re-run failed", "gray")]):
    s.box(615, 80 + i * 56, 240, 48, q, sub, col, dashed=True)

s.group(260, 450, 610, 100, "packages/shared + packages/core", "purple", dashed=True)
s.box(275, 478, 185, 60, "repositories", "only module with SQL;\nctx.userId required", "purple", dashed=True)
s.box(470, 478, 185, 60, "core (pure)", "graph query, RRF,\nfit-by-measuring", "purple", dashed=True)
s.box(665, 478, 190, 60, "schemas + env", "Zod: routes, queues,\nMCP tools", "purple", dashed=True)

s.group(910, 50, 250, 500, "Stores")
s.box(925, 80, 220, 70, "Redis 8", "BullMQ + DLQ, L2 cache,\nctc:inval pub/sub", "blue")
s.box(925, 170, 220, 150, "Postgres 17 + pgvector", "graph_nodes, graph_edges,\ncapabilities, capability_versions,\ncap_files, cap_blobs, overrides,\nmemories, session_summaries,\nwf_runs, wf_steps, idempotency_keys", "blue")
s.box(925, 340, 220, 70, "Repo + git", "worktrees runs/<id>/wt,\nbranches ctc/<wf>-<id>", "blue")
s.box(925, 430, 220, 56, "Local files", "~/.claude skills, memory,\ntranscripts", "blue")
s.group(260, 590, 900, 90, "Model servers and agents (unchanged)", "gray")
s.box(275, 615, 200, 50, "TEI embedder", ":18300", "gray")
s.box(495, 615, 200, 50, "TEI reranker", ":18301", "gray")
s.box(715, 615, 200, 50, "llama-server", ":18302", "gray")
s.box(935, 615, 210, 50, "claude -p / codex", "user's own login", "gray")

s.arrow([(215, 100), (275, 100)], 1, HOT)
s.arrow([(545, 110), (572, 110), (572, 590)], 2, HOT, lx=572, ly=440)
s.arrow([(215, 130), (245, 130), (245, 180), (275, 180)], 3, HOT, lx=245, ly=155)
s.arrow([(125, 150), (125, 175)], 4, HOT, lx=140, ly=162)
s.arrow([(215, 200), (250, 200), (250, 245), (275, 245)], 5, COLD, lx=250, ly=222)
s.arrow([(545, 245), (590, 245), (590, 104), (615, 104)], 6, COLD, lx=590, ly=180)
s.arrow([(855, 104), (890, 104), (890, 200), (925, 200)], 7, COLD, lx=890, ly=150)
s.arrow([(855, 216), (880, 216), (880, 460), (925, 460)], 8, COLD, lx=880, ly=420)
s.arrow([(735, 412), (735, 440), (815, 440), (815, 615)], 9, COLD, lx=815, ly=575)
s.arrow([(855, 328), (900, 328), (900, 375), (925, 375)], 10, COLD, lx=900, ly=350)
s.arrow([(215, 275), (245, 275), (245, 310), (275, 310)], 11, COLD, lx=245, ly=292)
s.arrow([(1035, 80), (1035, 42), (250, 42), (250, 380), (275, 380)], 12, COLD, lx=700, ly=42)
legend = [
    "1. UserPromptSubmit / PreToolUse: curl, reply within 140 ms / 40 ms or empty (hot)",
    "2. prompt: embed + rerank skill seeds, then graph walk in RAM (hot)",
    "3. SessionStart: memory context, RRF recall, 10,000-char cap (hot read)",
    "4. tool, stop, session-end hooks write one spool file and exit (hot, no wait)",
    "5. web drains the spool: boot, file watch, 30 s sweep (cold)",
    "6. drain and /api enqueue BullMQ jobs; Postgres jobs row is the truth (cold)",
    "7. graph / library / memory jobs write Postgres through repositories (cold)",
    "8. library scans ~/.claude; memory imports memory files and transcripts (cold)",
    "9. llm queue calls llama-server one job at a time; library embeds via TEI (cold)",
    "10. runner: git worktree + setup hook + claude -p / codex per step attempt (cold)",
    "11. dashboard /api and MCP tools read through repositories (cold)",
    "12. ctc:inval: web reloads the RAM graph and skill vectors (cold)",
]
for i, t in enumerate(legend):
    s.text(25 + (i // 6) * 580, 710 + (i % 6) * 16, t, 11, HOT if "(hot" in t else COLD, anchor="start")
s.save("arch-merged.svg")
