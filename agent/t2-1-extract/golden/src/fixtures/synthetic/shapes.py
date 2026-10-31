"""Synthetic fixture for graph.ids: Python shapes the real fixtures do not cover."""
from __future__ import annotations

import functools
from dataclasses import dataclass


@dataclass
class Outer:
    size: int = 0

    class Inner:
        def deep(self) -> int:
            return 1

    @property
    def doubled(self) -> int:
        return self.size * 2

    @staticmethod
    def make() -> "Outer":
        return Outer(1)

    async def fetch(self) -> None:
        return None


@functools.cache
def cached(x: int) -> int:
    def helper(y: int) -> int:
        return y + 1
    return helper(x)


def Größe_Berechnen(n: int) -> int:
    return n


async def _private_async() -> None:
    lam = lambda: 1  # noqa: E731
    lam()
