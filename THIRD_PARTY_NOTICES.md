# Third-party notices

Code in this repository that was copied or adapted from another project. Everything else is written from scratch (CLAUDE.md, Decisions of 2026-10-20). A new entry needs a permissive license, a pinned permalink and an SPDX header at the copied lines.

## Sliding-window rate-limit script (Lua)

- **Where here**: `src/ctc/storage/cache.py`, the `_RATE_LUA` string (used by `Cache.hit_rate`).
- **Source**: [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge), file `mcpgateway/middleware/rate_limit_middleware.py`, lines 51-73 (`_SLIDING_WINDOW_LUA`), pinned at commit `85dabf0beb75d05f8ff230fb823f7fe60aa1871a`: <https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/mcpgateway/middleware/rate_limit_middleware.py#L51-L73>
- **Copyright**: "Copyright contributors to the MCP-CONTEXT-FORGE project" (source file header).
- **License**: Apache License 2.0 (`SPDX-License-Identifier: Apache-2.0`), full text at <https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/LICENSE>.
- **What Apache-2.0 asks of us** (section 4): give recipients a copy of the license (the link above), mark modified files with a prominent notice (the `changed:` line above `_RATE_LUA`), and keep the copyright and attribution notices of the source (this entry and the SPDX line). The source tree has no `NOTICE` file at that commit, so there is no further text to carry over.
- **What changed**: the clock comes from the Redis `TIME` command instead of the caller; the member is `<ms>-<random suffix>` so two requests in the same millisecond never collide; the window length is `ARGV[1]` (seconds); every call adds its request and returns the `ZCARD` (the caller compares it with the limit) instead of checking first and returning 1 or 0.
