"""K3 (PLAN.md): routing speed of the live daemon. Replays the own-eval dev prompts through POST /v1/route three times:

- cold: bundle:, sem:, emb: keys deleted from Redis (never FLUSHDB: streams, jobs and sessions share it). Run it against
  a freshly started daemon: its L1 would otherwise still hold the emb: vectors of an earlier run.
- L2: a new session_id per prompt, so ref (= sha256(session_id + prompt)) and bundle:{ref} miss; emb: hits, and the
  semantic cache (Redis FT.SEARCH) returns the cold pass's bundle.
- L1: the L2 requests again: bundle:{ref} from the daemon's RAM.

Wall time per request (client side, unix socket like the hook) → numpy p50/p95 per tier; semantic hit = the route wrote
no sem:{ref} of its own (a miss always does). Writes data/reports/latency-<date>.md.
`uv run python -m evaluation.latency_eval [--url http://127.0.0.1:18310]` (default: the configured unix socket).
"""

from __future__ import annotations

import argparse
import datetime
import json
import time
import uuid

import httpx
import numpy as np
import redis

from ctc.config import ROOT, cfg

TARGET_P95 = {"cold": 150, "L2": 15, "L1": 10}  # PLAN.md Constraints, ms


def flush(r: redis.Redis) -> int:
    n = 0
    for prefix in ("bundle:", "sem:", "emb:"):
        keys = list(r.scan_iter(f"{prefix}*", count=1000))
        for i in range(0, len(keys), 500):
            n += r.unlink(*keys[i : i + 500])
    return n


def run(c: httpx.Client, r: redis.Redis, prompts: list[str], sids: list[str]) -> tuple[list[float], int]:
    ms, sem = [], 0
    for q, sid in zip(prompts, sids):
        t = time.perf_counter()
        b = c.post("/v1/route", json={"prompt": q, "session_id": sid}).raise_for_status().json()
        ms.append((time.perf_counter() - t) * 1000)
        sem += not r.exists(f"sem:{b['ref']}")
    return ms, sem


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="daemon base URL; default: the unix socket from config")
    a = ap.parse_args()
    c = cfg()
    rows = [json.loads(line) for line in (ROOT / "data/processed/own-eval.jsonl").open()]
    prompts = [x["query"] for x in rows if x["split"] == 0]  # dev only; test stays held out
    client = httpx.Client(base_url=a.url, timeout=30) if a.url else httpx.Client(
        transport=httpx.HTTPTransport(uds=c["socket"]), base_url="http://ctc", timeout=30)
    r = redis.from_url(c["redis_url"])
    run_id = uuid.uuid4().hex[:6]
    sids = {t: [f"k3-{run_id}-{t}-{i}" for i in range(len(prompts))] for t in ("cold", "L2")}
    health = client.get("/v1/health").json()

    flushed = flush(r)
    out = {"cold": run(client, r, prompts, sids["cold"]), "L2": run(client, r, prompts, sids["L2"])}
    out["L1"] = (run(client, r, prompts, sids["L2"])[0], None)  # bundle hits never reach the semantic cache
    for t in sids.values():  # the turn vectors and sess:last these sessions left
        for sid in t:
            r.delete(f"sess:{sid}:turns", f"sess:{sid}:last")

    day = datetime.date.today().isoformat()
    lines = [f"# K3 routing latency ({day})", "",
             (f"{len(prompts)} own-eval dev prompts through `POST /v1/route` ({a.url or 'unix socket ' + c['socket']}), "
             f"sequential, client wall time. Library `{health['library_version'][:8]}`, mode {health['mode']}, "
             f"services {', '.join(k for k, v in health.items() if v == 'ok')}. {flushed} cached keys flushed before cold."), "",
             "| tier | n | p50 ms | p95 ms | max ms | target p95 | semantic hits |", "|---|---|---|---|---|---|---|"]
    for t, (ms, sem) in out.items():
        p50, p95 = np.percentile(ms, [50, 95])
        ok = "ok" if p95 <= TARGET_P95[t] else "**over**"
        hits = "n/a" if sem is None else f"{sem}/{len(ms)} ({sem / len(ms):.0%})"
        lines.append(f"| {t} | {len(ms)} | {p50:.1f} | {p95:.1f} | {max(ms):.1f} | ≤ {TARGET_P95[t]} ({ok}) | {hits} |")
    lines += ["", ("- cold: search + rerank + decide on every prompt, except near-duplicates the semantic cache "
              f"catches within the pass (its hit count). DB: {'Supabase (session pooler)' if 'supabase' in (cfg()['database_url'] or '') else 'local dev Postgres'}; dense search runs in RAM, keywords + overrides + recall are one parallel DB hop."),
              ("- L2 = semantic-cache path: embedding from cache, then session/project blend "
              "and one FT.SEARCH; no search, no rerank."),
              "- L1 = bundle:{ref} in daemon RAM (the same prompt in the same session again).",
              "- The K2 benchmark shared the TEI/reranker servers during this run, so cold numbers carry that noise."]
    path = ROOT / f"data/reports/latency-{day}.md"
    path.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"→ {path}")


if __name__ == "__main__":
    main()
