"""In-memory capability store: scanned capabilities + cached TEI vectors, searched with numpy.

# ponytail: brute-force cosine over ~1k capabilities, no DB. Used when no CTC_DATABASE_URL is set; same surface as the
# Postgres Store's search path: async candidates()/overrides(), catalog + sync get().
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from pathlib import Path

import numpy as np

from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import Capability, default_roots, scan_library

CACHE = Path.home() / ".claudethecaller" / "embeddings.npz"
_STOP = {"a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "is", "it", "this", "that", "my", "me", "i", "with", "be", "do", "how", "what", "can", "you"}


def doc_text(c: Capability) -> str:
    return f"{c.name}: {c.description}"[:1000]


def tokens(text: str) -> set[str]:
    plain = "".join(ch for ch in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(ch))
    return {t for t in re.findall(r"\w+", plain) if t not in _STOP}


class LocalStore:
    def __init__(self, project_dir: Path):
        self.caps, self.warnings = scan_library(default_roots(project_dir))
        self.catalog = {c.id: {"id": c.id, "kind": c.kind, "name": c.name, "namespace": c.namespace, "invoke": c.invoke,
                               "description": c.description, "summary": None, "triggers": [], "cluster_id": None,
                               "path": c.path, "hash": c.hash} for c in self.caps}
        self.toks = [tokens(c.name.replace("-", " ") + " " + c.description) for c in self.caps]
        self.vecs = np.zeros((0, 0), dtype="float32")

    async def build(self, embedder: Embedder) -> int:
        """Embed every capability, reusing cached vectors keyed by sha256(model + text). Returns how many were new."""
        cached: dict[str, np.ndarray] = {}
        if CACHE.exists():
            z = np.load(CACHE)
            cached = dict(zip(z["keys"].tolist(), z["vecs"]))
        if not embedder.model_version:
            await embedder.embed(["warmup"], "doc")  # learns the model id for the cache key
        texts = [doc_text(c) for c in self.caps]
        keys = [hashlib.sha256((embedder.model_version + t).encode()).hexdigest() for t in texts]
        missing = [i for i, k in enumerate(keys) if k not in cached]
        for start in range(0, len(missing), 32):  # TEI max_client_batch_size = 32
            batch = missing[start : start + 32]
            for i, v in zip(batch, await embedder.embed([texts[i] for i in batch], "doc")):
                cached[keys[i]] = v
        vecs = np.stack([cached[k] for k in keys]).astype("float32")
        self.vecs = vecs / np.clip(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9, None)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        np.savez(CACHE, keys=np.array(keys), vecs=self.vecs)
        return len(missing)

    async def candidates(self, qv: np.ndarray, query: str, k: int) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
        sims = self.vecs @ (qv / (np.linalg.norm(qv) or 1.0))
        dense = [(self.caps[i].id, float(sims[i])) for i in np.argsort(-sims)[:k]]
        qt = tokens(query)
        scored = sorted(((len(qt & t) / len(t) ** 0.5, i) for i, t in enumerate(self.toks) if qt & t), reverse=True)
        sparse = [(self.caps[i].id, round(s, 4)) for s, i in scored[:k]]
        return dense, sparse

    async def overrides(self, project_id: str, user_id: str = "local") -> dict[str, str]:
        return {}  # overrides live in the DB; none locally

    def get(self, cap_id: str) -> dict:
        return self.catalog[cap_id]
