"""Shared fixtures: a throwaway schema on the scratch Postgres for the graph store tests (m6)."""

import asyncio
import uuid

import psycopg
import pytest

from ctc.config import cfg
from ctc.storage.store import Store


@pytest.fixture(scope="session")
def scratch():
    """(dsn, schema): a fresh ctc_test_<hex> schema with schema.sql applied, dropped at the end of the session."""
    dsn = cfg()["database_url"] or ""
    if not dsn or "supabase" in dsn:
        pytest.skip("graph store tests need a scratch Postgres: CTC_DATABASE_URL unset or Supabase")
    schema = f"ctc_test_{uuid.uuid4().hex[:8]}"  # never ctc or extensions: the drop below is cascade

    async def make() -> None:
        await (await Store.open(dsn, schema, pool_min=1, pool_max=2)).close()

    try:
        asyncio.run(make())
        yield dsn, schema
    finally:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(f"drop schema if exists {schema} cascade")


@pytest.fixture
def in_store(scratch):
    """call(fn) -> await fn(store) on a Store over the scratch schema.
    ponytail: one asyncio.run (and one pool) per call, no pytest-asyncio; fine for a handful of DB cases."""
    dsn, schema = scratch

    def call(fn):
        async def go():
            s = await Store.open(dsn, schema, pool_min=1, pool_max=2)
            try:
                return await fn(s)
            finally:
                await s.close()
        return asyncio.run(go())
    return call
