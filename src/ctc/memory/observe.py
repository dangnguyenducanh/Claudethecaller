# Adapted from claude-mem 15.2.1 (Apache-2.0, © 2026 Alex Newman): src/sdk/prompts.ts, src/sdk/parser.ts, src/services/worker/agents/ResponseProcessor.ts, src/shared/memory-retrieval-tools.ts. Changes: Python; one claude -p call per turn chunk read from the transcript (not one per tool use); the summary request rides on the turn's last chunk; fields are stripped, redacted and echo-filtered before they are stored.
"""m7 O2 capture (PLAN.md m7, specs/003-claude-mem-memory): job kind `observe`. A finished turn is re-read from the transcript on disk
(<private> cut, secrets redacted, tool output cut to field_max_chars), sent to one `claude -p --model haiku` call per ~32k chars with
claude-mem's observer prompts, and the XML reply becomes `observations` plus a turn summary. Nothing raw is stored: the job payload
holds ids and a byte offset, the result holds counts, and a reply that echoes the prompt or a tool result is cut before the write."""

from __future__ import annotations

import asyncio
import hashlib
import html
import importlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path

import orjson
import yaml

from ctc.config import ROOT, cfg
from ctc.graph import db, extract
from ctc.ingestion.history import typed_prompt
from ctc.llm.client import _redact
from ctc.memory.tags import TAG_NAMES, strip_tags
from ctc.runner import proc
from ctc.runner.engine import fresh_tokens
from ctc.server.jobs import submit

log = logging.getLogger(__name__)

MODE = ROOT / "config" / "observe-mode.yaml"
PENDING = "observe:pending"  # graph_sources row (per project): info.sessions = sessions whose turns hit the usage limit and still wait
OBSERVATION_SCHEMA_REMINDER = ("Your previous reply used tags outside the observation format. Use only <type>, <title>, <subtitle>, "
                               "<facts>, <narrative>, <concepts>, <files_read> and <files_modified> inside each <observation>.")
OPEN = tuple(f"<{n}" for n in TAG_NAMES)  # a text part that opens with one of these starts a turn even when typed_prompt drops it
READ_TOOLS, WRITE_TOOLS = {"Read"}, {"Edit", "MultiEdit", "Write", "NotebookEdit"}
SUMMARY_KEYS = ("request", "investigated", "learned", "completed", "next_steps", "notes")
# claude-mem's retrieval tools (src/shared/memory-retrieval-tools.ts): observing a search of the memory would record the memory in the memory
BARE = {"dumb_search", "claude_mem_search", "claude_mem_timeline", "claude_mem_get_observations", "mem_search", "get_summaries"}
RETRIEVAL = BARE | {"search", "timeline", "get_observations", "get_tool_uses", "session_start_context", "observation_search",
                    "observation_context", "memory_search", "memory_context", "save_memory"}
SERVERS = ("claude-mem", "claude_mem", "mcp-search", "mcp_search", "cmem")
SESSION_SQL = ("select p.name, p.path, s.id as sid, s.observed_bytes, s.observed_prompts from projects p left join sessions s"
               " on s.id = %s and s.user_id = p.user_id and s.project_id = p.id where p.user_id = %s and p.id = %s")
TITLES_SQL = "select title from observations where session_id = %s and deleted_at is null order by id desc limit %s"
OBS_SQL = """
insert into observations (user_id, project_id, session_id, prompt_number, type, title, subtitle, narrative, facts, concepts, files_read,
  files_modified, content_hash, discovery_tokens, model, created_at, embedding)
values (%(u)s, %(p)s, %(s)s, %(n)s, %(type)s, %(title)s, %(subtitle)s, %(narrative)s, %(facts)s, %(concepts)s, %(fr)s, %(fm)s, %(h)s,
  %(tok)s, 'haiku', coalesce(%(at)s::timestamptz, clock_timestamp()), %(v)s)
on conflict (session_id, content_hash) do nothing
"""
SUMMARY_SQL = """
insert into session_summaries (user_id, project_id, session_id, prompt_number, request, investigated, learned, completed, next_steps, notes,
  files_read, files_edited, discovery_tokens, model, created_at)
values (%(u)s, %(p)s, %(s)s, %(n)s, %(request)s, %(investigated)s, %(learned)s, %(completed)s, %(next_steps)s, %(notes)s, %(fr)s, %(fe)s,
  %(tok)s, 'haiku', coalesce(%(at)s::timestamptz, clock_timestamp()))
on conflict (session_id, prompt_number) do update set request = excluded.request, investigated = excluded.investigated,
  learned = excluded.learned, completed = excluded.completed, next_steps = excluded.next_steps, notes = excluded.notes,
  files_read = excluded.files_read, files_edited = excluded.files_edited, discovery_tokens = excluded.discovery_tokens,
  model = excluded.model, created_at = excluded.created_at
"""


def load_mode() -> dict:
    return yaml.safe_load(MODE.read_text(encoding="utf-8"))


# ---- transcript -> turns ----
def _recursive(name: str) -> bool:
    if name.startswith(("memory_", "mcp__claudethecaller__memory_")) or name in BARE:
        return True
    m = re.fullmatch(r"mcp__(.+?)__(.+)", name)
    return bool(m and any(k in m[1].lower() for k in SERVERS) and m[2] in RETRIEVAL)


def _keep(o: dict, bash: list, name, inp: dict) -> bool:
    """The tool-event gate: skip_tools, our own and claude-mem's memory tools, session-memory files, skip_bash_patterns."""
    if not isinstance(name, str) or name in o["skip_tools"] or _recursive(name):
        return False
    if "session-memory" in str(inp.get("file_path") or inp.get("notebook_path") or ""):
        return False
    return not (name == "Bash" and any(b.search(str(inp.get("command") or "")) for b in bash))


def _text(c) -> str:
    if isinstance(c, list):  # a tool_result's content blocks: text kept, an image or other block elided
        return "\n".join(str(x.get("text", "")) if isinstance(x, dict) and x.get("type") == "text" else "[non-text block]" for x in c)
    return c if isinstance(c, str) else ""


def read_turns(path: str, start: int, upto: int) -> tuple[list[dict], int, int]:
    """(turns, new byte offset, typed prompts seen) from `path` between `start` and the last "\\n" at or before `upto`; a half-written
    last line is left for the next job and a file shorter than `start` restarts at 0. A turn opens at a main-chain user row with text
    and no tool_result that typed_prompt() accepts or that starts with a memory tag (so a <private>-only prompt still opens one):
    {prompt (strip_tags'd; "" = fully private: no events, still counted), events [{tool, input, output, ts}] (gated, tool_use paired
    with its tool_result by id), text (the last assistant text), ts (the last row's timestamp)}. isMeta and sidechain rows are skipped.
    ponytail: rows before the first boundary of a read (a Stop that landed mid-turn) are dropped; a first read holds the file in memory."""
    o = cfg()["memory"]["observe"]
    bash = [re.compile(x) for x in o["skip_bash_patterns"]]
    path = Path(path)
    size = path.stat().st_size
    start = 0 if start > size else start
    with path.open("rb") as f:
        f.seek(start)
        data = f.read(max(0, min(upto, size) - start))
    data = data[: data.rfind(b"\n") + 1]
    turns, cur, pending, seen = [], None, {}, 0
    for line in data.splitlines():
        try:
            r = orjson.loads(line)
        except ValueError:
            continue
        if not isinstance(r, dict) or r.get("type") not in ("user", "assistant") or r.get("isMeta") or r.get("isSidechain"):
            continue
        m = r.get("message") if isinstance(r.get("message"), dict) else {}
        c = m.get("content")
        parts = [{"type": "text", "text": c}] if isinstance(c, str) else [x for x in c if isinstance(x, dict)] if isinstance(c, list) else []
        ts = r["timestamp"] if isinstance(r.get("timestamp"), str) else None
        if r["type"] == "user":
            texts = [str(x.get("text", "")) for x in parts if x.get("type") == "text"]
            results = [x for x in parts if x.get("type") == "tool_result"]
            if texts and not results and (typed_prompt(r) or any(t.lstrip().startswith(OPEN) for t in texts)):
                raw = "\n".join(t for t in texts if t.strip() and (not t.strip().startswith(("<", "[Request interrupted")) or t.lstrip().startswith(OPEN)))
                cur = {"prompt": strip_tags(raw), "events": [], "text": "", "ts": ts}
                turns.append(cur)
                pending, seen = {}, seen + 1
                continue
            for x in results:
                if (ev := pending.get(x.get("tool_use_id"))) is not None:
                    ev["output"] = _text(x.get("content"))
        elif cur is not None and cur["prompt"]:
            if tx := [x["text"] for x in parts if x.get("type") == "text" and isinstance(x.get("text"), str) and x["text"].strip()]:
                cur["text"] = "\n".join(tx)
            for x in parts:
                if x.get("type") == "tool_use" and isinstance(x.get("input"), dict) and _keep(o, bash, x.get("name"), x["input"]):
                    pending[x.get("id")] = ev = {"tool": x["name"], "input": x["input"], "output": "", "ts": ts or ""}
                    cur["events"].append(ev)
        if cur is not None and ts:
            cur["ts"] = ts
    return turns, start + len(data), seen


# ---- turn -> prompt ----
_IMG = re.compile(r"data:image/[^;,\s]+;base64,[A-Za-z0-9+/=]{1024,}")


def _field(v, n: int) -> str:
    """One prompt field. Order matters: strip_tags -> _redact on the whole field, then the cut (cutting first could drop a PEM block's
    END line and leave the key in the head). Over n chars: 60% head + 30% tail + an elision marker the model can see."""
    s = v if isinstance(v, str) else json.dumps(v, indent=2, ensure_ascii=False, default=str)
    s = _redact(strip_tags(_IMG.sub(lambda m: f"data:image;base64,<elided {len(m[0])} chars>", s)))
    if len(s) <= n:
        return s
    h, t = int(n * 0.6), int(n * 0.3)
    return f'{s[:h]}\n... <elided chars="{len(s) - h - t}" original_size_chars="{len(s)}" reason="oversize" /> ...\n{s[len(s) - t:]}'


def _block(ev: dict, n: int) -> str:
    return (f"<observed_from_primary_session>\n  <what_happened>{ev['tool']}</what_happened>\n  <occurred_at>{ev['ts']}</occurred_at>\n"
            f"  <parameters>{_field(ev['input'], n)}</parameters>\n  <outcome>{_field(ev['output'], n)}</outcome>\n</observed_from_primary_session>")


def _pack(events: list[dict], fmax: int, cap: int) -> list[list[dict]]:
    """Consecutive events packed into chunks of about `cap` rendered chars (a chunk always takes at least one)."""
    out, cur, size = [], [], 0
    for ev in events:
        n = len(_block(ev, fmax))
        if cur and size + n > cap:
            out.append(cur)
            cur, size = [], 0
        cur.append(ev)
        size += n
    return [*out, cur] if cur else out


def _instructions(mode: dict) -> str:
    """observerInstructions: depends on the mode alone, so it is a byte-stable prefix of every prompt (provider prompt caches)."""
    p = {k: v.strip() for k, v in mode["prompts"].items()}
    tags = " | ".join(t["id"] for t in mode["observation_types"])
    fact, concept, file = (f"{k}>{p['xml_' + k + '_placeholder']}</{k}>" for k in ("fact", "concept", "file"))
    return f"""{p['system_identity']}

{p['observer_role']}

{p['spatial_awareness']}

{p['recording_focus']}

{p['skip_guidance']}

{p['output_format_header']}

<observation>
  <type>[ {tags} ]</type>
  <!--
    {p['type_guidance']}
  -->
  <title>{p['xml_title_placeholder']}</title>
  <subtitle>{p['xml_subtitle_placeholder']}</subtitle>
  <facts>
    <{fact}
    <{fact}
    <{fact}
  </facts>
  <!--
    {p['field_guidance']}
  -->
  <narrative>{p['xml_narrative_placeholder']}</narrative>
  <concepts>
    <{concept}
    <{concept}
  </concepts>
  <!--
    {p['concept_guidance']}
  -->
  <files_read>
    <{file}
    <{file}
  </files_read>
  <files_modified>
    <{file}
    <{file}
  </files_modified>
</observation>
{mode['prompts']['format_examples'].strip()}

{p['footer']}"""


def _summary_request(mode: dict, turn: dict, n: int) -> str:
    """buildSummaryPrompt, appended to the turn's last chunk: one reply holds the observations and the <summary> (claude-mem sends
    it as a separate call, with a tag rule that would forbid the observations)."""
    p = {k: v.strip() for k, v in mode["prompts"].items()}
    tags = "\n".join(f"  <{k}>{p['xml_summary_' + k + '_placeholder']}</{k}>" for k in SUMMARY_KEYS)
    return f"""--- MODE SWITCH: PROGRESS SUMMARY ---
This request is complete. After the <observation> blocks (if any), end your reply with one <summary> block for it; nothing may follow it.

{p['header_summary_checkpoint']}
{p['summary_instruction']}

{p['summary_context_label']}
{_field(turn['text'], n)}

{p['summary_format_instruction']}
<summary>
{tags}
</summary>

If there is genuinely nothing to summarize, put <skip_summary reason="nothing durable" /> in place of the <summary> block."""


def build_prompt(mode: dict, turn: dict, prior_titles: list[str], chunk: list[dict], with_summary: bool) -> str:
    """Observer instructions, the session's recent titles (so it skips what is recorded), the typed request, one block per tool event,
    the closing rules, and (with_summary) the summary request. Every field is stripped and redacted before it is cut."""
    n = cfg()["memory"]["observe"]["field_max_chars"]
    ctx = ("\n<session_start_context>\n" + "\n".join(f"- {t}" for t in prior_titles) + "\n</session_start_context>\n\n"
           "The context above is what you have already recorded for this work. Continue from there: do not re-record it, and do not "
           "treat its absence from the conversation above as meaning the work did not happen.\n") if prior_titles else ""
    blocks = [_block(ev, n) for ev in chunk]
    hint = ('\nIf you see "[REDACTED]", that text was a secret removed before it reached you. Do not guess it or copy the marker into '
            'memory.\n') if any("[REDACTED]" in b for b in blocks) else ""
    init = (f"<observed_from_primary_session>\n  <user_request>{_field(turn['prompt'], n)}</user_request>\n"
            f"  <requested_at>{(turn.get('ts') or '')[:10]}</requested_at>\n</observed_from_primary_session>")
    rules = ('If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the '
             "observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range."
             f'{hint}\nReturn one or more <observation>...</observation> blocks, or <skip_summary reason="noise" /> if these tool uses '
             "should be skipped.\nConcrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection "
             'count as durable discoveries and should be recorded.\nNever reply with an empty response, or with prose such as "Skipping" or '
             f"any explanation outside XML. Only <observation> blocks, {'the <summary> block, ' if with_summary else ''}or the <skip_summary /> "
             "sentinel complete this request; anything else is asked again once, then discarded.")
    summary = [_summary_request(mode, turn, n)] if with_summary else []
    return "\n\n".join([_instructions(mode) + ctx, init, mode["prompts"]["header_memory_start"].strip(), *blocks, rules, *summary])


# ---- reply -> rows ----
_FENCE = re.compile(r"^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$", re.IGNORECASE)
_LABEL = re.compile(r"\[?\s*(?:\*\*)?title(?:\*\*)?\s*:\s*(.+?)\s*\]?", re.IGNORECASE | re.DOTALL)  # "Title: Foo" / "[**title**: Foo]"


def _one(b: str, tag: str) -> str:
    m = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", b, re.IGNORECASE)
    return html.unescape(m[1].strip()) if m else ""


def _many(b: str, outer: str, inner: str) -> list[str]:
    m = re.search(rf"<{outer}>([\s\S]*?)</{outer}>", b, re.IGNORECASE)
    items = (html.unescape(i.strip()) for i in re.findall(rf"<{inner}>([\s\S]*?)</{inner}>", m[1], re.IGNORECASE)) if m else ()
    return [i for i in items if i]


def parse_reply(text: str, mode: dict) -> tuple[list[dict], dict | None, bool]:
    """(observations, summary, parsed_ok) from the XML reply (claude-mem sdk/parser.ts): each <observation> and the <summary> are parsed
    on their own, <skip_summary/> means no summary, entities are decoded, a label-wrapped title is unwrapped, an unknown type drops the
    observation and an unknown concept is dropped. parsed_ok is False when no block or sentinel was found (the caller retries)."""
    text = m[1] if (m := _FENCE.match(text)) else text
    types, concepts = {t["id"] for t in mode["observation_types"]}, {c["id"] for c in mode["observation_concepts"]}
    obs, ok = [], False
    for m in re.finditer(r"<observation>([\s\S]*?)</observation>", text, re.IGNORECASE):
        ok, b = True, m[1]
        t = re.search(r"<type>((?:(?!<type>)[\s\S])*?)</type>", b, re.IGNORECASE)  # the last <type> opened before the first </type>
        typ = html.unescape(re.sub(r"</?[A-Za-z_][\w-]*\b[^>]*>", "", t[1])).strip() if t else ""
        title = _one(b, "title")
        title = lm[1] if (lm := _LABEL.fullmatch(title)) else title
        cs = [c.split(":")[0].strip() for c in _many(b, "concepts", "concept")]
        if typ in types:
            obs.append({"type": typ, "title": title, "subtitle": _one(b, "subtitle"), "narrative": _one(b, "narrative"),
                        "facts": _many(b, "facts", "fact"), "concepts": [c for c in cs if c in concepts and c != typ],
                        "files_read": _many(b, "files_read", "file"), "files_modified": _many(b, "files_modified", "file")})
    summ = None
    if m := re.search(r"<summary>([\s\S]*?)</summary>", text, re.IGNORECASE):
        s = {k: _one(m[1], k) for k in SUMMARY_KEYS}
        summ, ok = (s, True) if any(s.values()) else (None, ok)
    if re.search(r"<skip_summary\b[^>]*/>", text, re.IGNORECASE):
        summ, ok = None, True
    return obs, summ, ok


def content_hash(session_id: str, title: str, narrative: str) -> str:
    return hashlib.sha256(f"{session_id}\0{title}\0{narrative}".encode()).hexdigest()[:16]


def _rel(p: str, root: Path) -> str:
    try:
        return str(Path(p).relative_to(root))
    except ValueError:
        return p


def _evidence(chunk: list[dict], root: Path) -> tuple[list[str], list[str]]:
    """(files read, files modified) from the chunk's tool inputs, relative to the project path (ResponseProcessor.ts L38-269): the
    model's own file lists are only added to `read`, `modified` is never the model's word."""
    read, mod = [], []
    for e in chunk:
        out = read if e["tool"] in READ_TOOLS else mod if e["tool"] in WRITE_TOOLS else []
        out += [_rel(e["input"][k], root) for k in ("file_path", "notebook_path") if isinstance(e["input"].get(k), str) and e["input"][k].strip()]
    return list(dict.fromkeys(read)), list(dict.fromkeys(mod))


# ---- privacy: nothing the user typed or a tool printed comes back out of the model ----
_DEFUSE = re.compile(r"</?ctc-memory-context", re.IGNORECASE)


def _clean(s: str) -> str:
    """strip_tags + redact a parsed field; a leftover <ctc-memory-context / </ctc-memory-context can not close the injected wrapper."""
    return _DEFUSE.sub("‹ctc-memory-context", _redact(strip_tags(s)))


def _flat(s: str) -> str:
    return " ".join(s.lower().split())


def _win(s: str, n: int) -> set[str]:
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def _sanitize(obs: list[dict], summ: dict | None, prompt: str, tool_texts: list[str]) -> tuple[list[dict], dict | None]:
    """The history.py echo rules (SC-002): `request` and `title` are blanked when they echo the typed prompt (the whole prompt of >= 15
    chars, or any 40-char span); a fact is dropped, and a sentence of any other text field cut, when it shares a 200-char window with
    the chunk's tool text. An observation left without a title is dropped.
    ponytail: a copied span under 40 chars of a longer prompt, or under 200 of a tool result, gets through."""
    fp, spans = _flat(prompt), _win(_flat(prompt), 40)
    tools = set().union(*(_win(_flat(t), 200) for t in tool_texts))

    def prompt_echo(x: str) -> bool:
        return bool(fp) and (not spans.isdisjoint(_win(_flat(x), 40)) or (15 <= len(fp) < 40 and fp in _flat(x)))

    def tool_echo(x: str) -> bool:
        return not tools.isdisjoint(_win(_flat(x), 200))

    def cut(x: str) -> str:
        x = _clean(x)
        if not tool_echo(x):
            return x
        x = " ".join(s for s in re.split(r"(?<=[.!?])\s+", x) if not tool_echo(s))
        return "" if tool_echo(x) else x  # a window across two kept sentences

    out = []
    for o in obs:
        title = _clean(o["title"])
        if title and not prompt_echo(title):
            out.append({**o, "title": title, "subtitle": cut(o["subtitle"]), "narrative": cut(o["narrative"]),
                        "facts": [f for f in (_clean(x) for x in o["facts"]) if f and not tool_echo(f)]})
    s = None
    if summ:
        s = {k: cut(v) for k, v in summ.items()} | {"request": "" if prompt_echo(_clean(summ["request"])) else cut(summ["request"])}
    return out, s if s and any(s.values()) else None


# ---- the job ----
async def _wait(st, u: str, p: str, waiting: list[dict], entry: dict) -> None:
    """Add the session to observe:pending: its turns hit the usage limit, and a session that already ended sends no further Stop."""
    await db.set_source(st.store, u, p, PENDING, "", {"sessions": [e for e in waiting if e["session_id"] != entry["session_id"]] + [entry]})


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `observe`, payload {session_id, project_id, user_id, transcript_path, final, upto}. Returns {turns, calls, observations,
    summaries, dropped_chunks, failed_chunks, skipped?, quota_until?}: counts and status codes only, never reply or prompt text (jobs.result
    and jobs.error live in Supabase). A quota hit stores nothing and leaves the watermark, so the same turns are read again later.
    ponytail: observe:pending and extract:quota are per project, so a session waits for the next job of its own project;
    `model` is the alias 'haiku' because proc.run_agent returns no model id."""
    if st.cfg["mode"] != "local":  # the observer spends the owner's own claude.ai login and reads files on this host
        return {"skipped": "mode"}
    sid, u, p = payload["session_id"], payload.get("user_id", "local"), payload["project_id"]
    path = Path(payload["transcript_path"]).expanduser().resolve()
    # the TCP port is open to every local user: only Claude Code transcripts are read (same rule as ai/extract.run_job)
    if path.suffix != ".jsonl" or not path.is_relative_to(Path(st.cfg["claude_home"]).resolve() / "projects"):
        raise ValueError(f"not a Claude Code transcript: {path}")
    o = st.cfg["memory"]["observe"]
    s = await st.store.fetchrow(SESSION_SQL, (sid, u, p))
    if s and {s["name"], Path(s["path"]).name} & set(st.cfg["history"]["skip_projects"]):
        return {"skipped": "project"}
    if not s or not s["sid"]:  # the FKs need the row; the next prompt hook creates it
        return {"skipped": "no session"}
    entry = {"session_id": sid, "project_id": p, "user_id": u, "transcript_path": payload["transcript_path"]}
    q = await db.get_source(st.store, u, p, extract.QUOTA)
    paused = bool(q and q["version"] and datetime.fromisoformat(q["version"]).astimezone() > datetime.now().astimezone())
    row = await db.get_source(st.store, u, p, PENDING)
    waiting = (row["info"].get("sessions") if row else None) or []
    if waiting and not paused:  # the limit has reset: every session that waited gets its job back, from its own watermark
        for e in waiting:
            if e["session_id"] != sid:
                await submit(st, "observe", {**e, "final": True}, e.get("user_id", "local"))
        await db.set_source(st.store, u, p, PENDING, "", {"sessions": []})
        waiting = []
    size = path.stat().st_size
    start, base = (0, 0) if size < s["observed_bytes"] else (s["observed_bytes"], s["observed_prompts"])  # a shrunk file restarts both
    turns, end, seen = await asyncio.to_thread(read_turns, str(path), start, payload.get("upto") or size)
    res = {"turns": len(turns), "calls": 0, "observations": 0, "summaries": 0, "dropped_chunks": 0, "failed_chunks": 0}
    fmax, cap = o["field_max_chars"], o["max_calls_per_job"]
    plan = []  # [turn, chunk, asks for the summary]
    for i, t in enumerate(turns, 1):
        t["n"] = base + i
        for c in _pack(t["events"], fmax, o["chunk_chars"]):
            if len(plan) < cap:
                plan.append([t, c, False])
            else:
                res["dropped_chunks"] += 1  # ponytail: a very long turn loses its tail; raise max_calls_per_job or split jobs
    for k in {id(t): k for k, (t, _, _) in enumerate(plan)}.values():
        plan[k][2] = True  # each turn's last kept chunk carries its summary request
    if not plan:  # chat-only, private or fully skipped turns: nothing to call, only the watermark moves
        if (end, base + seen) != (s["observed_bytes"], s["observed_prompts"]):
            await st.store.execute("update sessions set observed_bytes = %s, observed_prompts = %s where id = %s", (end, base + seen, sid))
        return res
    if paused:
        await _wait(st, u, p, waiting, entry)
        return res | {"quota_until": q["version"]}
    pre = await proc.preflight()
    if not pre["ok"]:
        log.warning("observe: claude is not usable: %s", pre["error"])
        return res | {"skipped": "claude not usable"}
    mode, cmd = load_mode(), extract.argv("haiku")
    wd = Path(st.cfg["graph_extract"]["dir"]).expanduser()
    wd.mkdir(parents=True, exist_ok=True)
    (wd / "observe.jsonl").write_bytes(b"")  # this job's stream-json lines, like graph_extract's last.jsonl
    prior = [r["title"] for r in reversed(await st.store.fetch(TITLES_SQL, (sid, o["prior_titles"])))]
    root, rows, sums = Path(s["path"]), [], {}
    for k, (t, chunk, last) in enumerate(plan):
        prompt, got, status = build_prompt(mode, t, prior, chunk, last), None, ""
        texts = [_field(e[f], fmax) for e in chunk for f in ("input", "output")]
        for attempt in (0, 1):  # a failed call and an unparsable reply are both retried once
            if res["calls"] >= cap:
                break
            res["calls"] += 1
            r = await extract._call(cmd, prompt + (f"\n\n{OBSERVATION_SCHEMA_REMINDER}" if attempt else ""), str(wd / "observe.jsonl"), 120)
            status = r["status"]
            if status == "quota":
                if r.get("resets_at"):
                    await db.set_source(st.store, u, p, extract.QUOTA, r["resets_at"])
                await _wait(st, u, p, waiting, entry)
                return res | {"quota_until": r.get("resets_at")}
            if status == "done":
                obs, summ, ok = parse_reply((r.get("output") or {}).get("result") or "", mode)
                if ok:
                    got = (obs, summ, fresh_tokens(r.get("usage")))
                    break
        if not got:  # never raised, never logged with reply text: counts only
            res["dropped_chunks" if status in ("", "done") else "failed_chunks"] += 1
            continue
        obs, summ = _sanitize(got[0], got[1], t["prompt"], texts)
        read, mod = _evidence(chunk, root)
        for x in obs:
            rows.append({**x, "n": t["n"], "at": t["ts"], "tok": got[2] // len(obs), "hash": content_hash(sid, x["title"], x["narrative"]),
                         "files_read": list(dict.fromkeys([*read, *(_rel(f, root) for f in x["files_read"])])), "files_modified": mod})
        if summ:
            sums[t["n"]] = summ | {"at": t["ts"], "tok": 0 if obs else got[2]}
        prior = [*prior, *(x["title"] for x in obs)][-o["prior_titles"]:]
        await progress((k + 1) / len(plan))
    vecs = await st.embedder.embed(["\n".join([x["title"], x["subtitle"], x["narrative"], *x["facts"]]) for x in rows], "doc") if rows else []
    a = {"u": u, "p": p, "s": sid}

    async def go(conn):
        n_obs = n_sum = 0
        async with conn.transaction(), conn.cursor() as cur:
            for x, v in zip(rows, vecs):
                await cur.execute(OBS_SQL, a | {"n": x["n"], "type": x["type"], "title": x["title"], "subtitle": x["subtitle"],
                                                "narrative": x["narrative"], "facts": x["facts"], "concepts": x["concepts"], "fr": x["files_read"],
                                                "fm": x["files_modified"], "h": x["hash"], "tok": x["tok"], "at": x["at"], "v": v})
                n_obs += cur.rowcount
            for n, m in sums.items():  # a summary's files are rolled up from its turn's observations
                mine = [x for x in rows if x["n"] == n]
                fr = list(dict.fromkeys(f for x in mine for f in x["files_read"]))
                fe = list(dict.fromkeys(f for x in mine for f in x["files_modified"]))
                await cur.execute(SUMMARY_SQL, a | {"n": n, "fr": fr, "fe": fe, **m})
                n_sum += cur.rowcount
            await cur.execute("update sessions set observed_bytes = %s, observed_prompts = %s where id = %s", (end, base + seen, sid))
        return n_obs, n_sum

    res["observations"], res["summaries"] = await st.store._run(go)
    if res["observations"] or res["summaries"]:
        try:  # lazy: observations.py is written in the same wave
            await importlib.import_module("ctc.memory.observations").refresh_context(st, u, p)
        except Exception:
            log.exception("observe: refresh_context failed")
            await st.cache.delete(f"ctx:{u}:{p}")
    log.info("observe %s: %s", sid, res)
    return res


if __name__ == "__main__":
    import tempfile

    def _row(kind, content, ts):
        return {"type": kind, "timestamp": f"2026-10-26T10:00:{ts:02d}Z", "message": {"role": kind, "content": content}}

    rows = [_row("user", "fix it", 1), _row("assistant", [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": "t", "name": "Edit",
            "input": {"file_path": "/p/a.py"}}], 2), _row("user", [{"type": "tool_result", "tool_use_id": "t", "content": "done"}], 3),
            _row("user", "<private>x</private>", 4), _row("assistant", [{"type": "tool_use", "id": "u", "name": "Bash", "input": {"command": "ls"}}], 5)]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "t.jsonl"
        f.write_text("".join(json.dumps(r) + "\n" for r in rows) + '{"type": "us')
        size = f.stat().st_size
        turns, off, seen = read_turns(str(f), 0, size)
    assert seen == 2 and off == size - len('{"type": "us') and [t["prompt"] for t in turns] == ["fix it", ""]
    assert turns[0]["events"] == [{"tool": "Edit", "input": {"file_path": "/p/a.py"}, "output": "done", "ts": "2026-10-26T10:00:02Z"}] and turns[1]["events"] == []
    m = load_mode()
    p = build_prompt(m, turns[0], ["Earlier"], turns[0]["events"], True)
    assert "<user_request>fix it</user_request>" in p and "Earlier" in p and "<summary>" in p
    obs, summ, ok = parse_reply("<observation><type>bugfix</type><title>Title: A &amp; B</title></observation>"
                                "<summary><request>r</request></summary>", m)
    assert ok and obs[0]["title"] == "A & B" and summ["request"] == "r" and parse_reply("nope", m) == ([], None, False)
    assert parse_reply('<skip_summary reason="x"/>', m) == ([], None, True)
    assert content_hash("s", "t", "n") == hashlib.sha256(b"s\0t\0n").hexdigest()[:16]
    assert _sanitize([{**obs[0], "title": "please fix it today now ok"}], None, "fix it today now ok", []) == ([], None)
    print("observe self-check ok")
