# Dispatch — 7 tickets, 4 waves on m6-graph

Rule (owner): tickets that touch the same file never run at the same time. Builders never commit; the lead commits each ticket and does the wiring listed in tasks.md T049–T052.

| Wave | Tickets (parallel) | Lead after the wave |
|---|---|---|
| 1 | 01 store + import · 02 parser | commit 01, 02 |
| 2 | 03 links + build · 04 extractor + triggers | `ctc graph extract`; commit 03, 04 |
| 3 | 05 pull tools + export · 06 push + file note | `ctc graph export`; commit 05, 06 |
| 4 | 07 eval | commit 07; PLAN.md ticks; 1 reviewer → 1 fixer if needed |

Shared files and their owner per wave: `cli.py` (01 → 03 → 06, lead between waves), `hooks.py` (04 → 06), `retrieval.yaml` (03 → 06 → 07). Lock table: specs/002-context-coding-graph/plan.md.
