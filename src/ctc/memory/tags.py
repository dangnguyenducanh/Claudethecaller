# Adapted from claude-mem 15.2.1 (Apache-2.0, © 2026 Alex Newman): src/utils/tag-stripping.ts. Changes: Python; adds ctc-memory-context; an unbalanced opener is stripped to the end of the text (upstream keeps it, we are privacy-first).
"""Memory tags (<private>, our own injected context, ...) are cut out of every text that is stored or sent to a model."""

from __future__ import annotations

import logging
import re
from collections import deque

log = logging.getLogger(__name__)

TAG_NAMES = ("private", "claude-mem-context", "ctc-memory-context", "system_instruction", "system-instruction",
             "persisted-output", "system-reminder")
MAX_TAG_COUNT = 100  # only logs above it: every tag is still stripped
_TAG = re.compile(r"<(/?)([A-Za-z_][A-Za-z0-9_-]*)")
_CLOSE_END = re.compile(r"\s*>")


def strip_tags(text: str) -> str:
    """Remove every balanced memory-tag block (nested ones too) in one linear scan. A close tag pairs with the earliest
    still-open tag of its name, so removal is maximal; a close inside an opener's own attribute text is not a close.
    An opener that never closes is removed to the end of the text. Result `.strip()`ed."""
    if "<" not in text:
        return text.strip()
    n, i, gt, total = len(text), 0, -1, 0
    opens: dict[str, deque[tuple[int, int]]] = {}  # name -> (start, attr_end) of the opens not closed yet, oldest first
    removed: list[tuple[int, int]] = []
    while m := _TAG.search(text, i):
        i, name = m.end(), m.group(2)
        if name not in TAG_NAMES:
            continue
        if m.group(1):  # </name  >
            if not (c := _CLOSE_END.match(text, i)):
                continue
            i = c.end()
            if (q := opens.get(name)) and m.start() >= q[0][1]:
                removed.append((q.popleft()[0], i))
                total += 1
        else:
            if gt < i:  # first `>` at or after the name; kept across openers so the scan stays linear
                gt = text.find(">", i)
                gt = n if gt < 0 else gt
            opens.setdefault(name, deque()).append((m.start(), gt))
    if total > MAX_TAG_COUNT:
        log.warning("tag count %d exceeds %d (length %d)", total, MAX_TAG_COUNT, n)
    removed += [(q[0][0], n) for q in opens.values() if q]  # unbalanced: the earliest unclosed opener to the end
    out, cur = [], 0
    for a, b in sorted(removed):
        out.append(text[cur:a])
        cur = max(cur, b)
    return "".join(out + [text[cur:]]).strip()


if __name__ == "__main__":
    import time

    assert strip_tags("a <private>x</private> b") == "a  b"
    assert strip_tags("<private>a<private>b</private>c</private>") == ""
    assert all(strip_tags(f"x <{t}>s</{t}> y") == "x  y" for t in TAG_NAMES)
    assert strip_tags("keep <private>never closed") == "keep" and strip_tags("a < b and x<y") == "a < b and x<y"
    assert strip_tags("<ctc-memory-context>\n- S1\n</ctc-memory-context>") == ""
    assert strip_tags('x <private n="</private>">h</private> y') == "x  y" and strip_tags("a </private> b") == "a </private> b"
    t = time.perf_counter()
    assert strip_tags("<private>s</private>y" * 200) == "y" * 200 and strip_tags("<private " * 5000) == ""
    assert time.perf_counter() - t < 0.05
    print("tags self-check ok")
