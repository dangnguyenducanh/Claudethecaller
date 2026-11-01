import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemCtx } from './ctx.ts';
import type { Db } from './db.ts';
import { RepoError } from './errors.ts';
import { createRepositories } from './index.ts';
import { exec, scratch, type Scratch } from './scratch.ts';
import { cases, seed, type Case, type Seed } from './tenancy.cases.ts';

const SYSTEM_ALLOWLIST = [
  'apiKeys.findByHash', 'cleanup.deleteUnreferencedBlobs', 'cleanup.listFinishedRuns', 'cleanup.pruneIdempotencyKeys', 'jobs.listQueued',
  'jobs.markDead', 'jobs.markDone', 'jobs.markFailed', 'jobs.markQueued', 'jobs.markRunning', 'jobs.setProgress', 'runner.listActiveRuns', 'runner.listRunningSteps',
];

let s: Scratch;
let a: Seed;
let b: Seed;
const sctx = createSystemCtx('tenancy test');

beforeAll(async () => {
  s = await scratch();
  a = await seed(s.repos, 'user-a', 0);
  b = await seed(s.repos, 'user-b', 1);
  await s.repos.system.jobs.markDone(sctx, b.jobId);
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

/** `from … where …` that selects the rows of `table` owned by `user`, reaching the owner through the parent for child tables. */
const ownedBy = (table: string, user: string): string => {
  const from = `"${s.schema}"."${table}" t`;
  const schema = `"${s.schema}"`;
  if (table === 'wf_steps') return `${from} join ${schema}.wf_runs p on p.id = t.run_id where p.user_id = '${user}'`;
  if (table === 'cap_files') {
    return `${from} join ${schema}.capability_versions v on v.id = t.version_id join ${schema}.capabilities p on p.id = v.cap_id where p.user_id = '${user}'`;
  }
  if (table === 'capability_versions' || table === 'cap_vectors') {
    return `${from} join ${schema}.capabilities p on p.id = t.cap_id where p.user_id = '${user}'`;
  }
  return `${from} where t.user_id = '${user}'`;
};

const tablesOf = async (): Promise<string[]> => {
  const res = await exec(s.url, `select table_name from information_schema.tables where table_schema = '${s.schema}' and table_name <> 'schema_migrations' order by 1`);
  return (res.rows as { table_name: string }[]).map((r) => r.table_name);
};

/** Every row that belongs to user A, whichever table it lives in, as sorted JSON text. */
async function dumpA(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of await tablesOf()) {
    const res = await exec(s.url, `select to_jsonb(t)::text as r from ${ownedBy(t, 'user-a')} order by 1`);
    out[t] = (res.rows as { r: string }[]).map((r) => r.r);
  }
  return out;
}

const isZero = (v: unknown): boolean => {
  if (v === null || v === undefined || v === 0 || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every(isZero);
  return false;
};
const leaks = (v: unknown): string[] => {
  const text = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x));
  return a.marks.filter((m) => text.includes(m));
};

const list = (): { name: string; c: Case }[] =>
  Object.entries(cases).flatMap(([d, fns]) => Object.entries(fns).flatMap(([f, c]) => (Array.isArray(c) ? c : [c]).map((x) => ({ name: `${d}.${f}`, c: x }))));

async function outcome(c: Case, ctx: { userId: string; projectId?: string }): Promise<unknown> {
  try {
    return await c.run({ r: s.repos, ctx, a, b });
  } catch (error) {
    return error;
  }
}

describe('tenancy', () => {
  it('D12(3) every function of every domain except system has a case, and every case has a function', () => {
    const fns = Object.entries(s.repos).filter(([d]) => d !== 'system').flatMap(([d, o]) => Object.entries(o).filter(([, v]) => typeof v === 'function').map(([f]) => `${d}.${f}`));
    const have = Object.entries(cases).flatMap(([d, o]) => Object.keys(o).map((f) => `${d}.${f}`));
    expect(fns.filter((k) => !have.includes(k)).sort()).toEqual([]);
    expect(have.filter((k) => !fns.includes(k)).sort()).toEqual([]);
  });

  it('D12(2) both users have at least one row in every table', async () => {
    const empty: string[] = [];
    for (const user of ['user-a', 'user-b']) {
      for (const t of await tablesOf()) {
        const res = await exec(s.url, `select count(*)::int as n from ${ownedBy(t, user)}`);
        if ((res.rows[0] as { n: number }).n === 0) empty.push(`${user}:${t}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it("D12(4)(5) user B's ctx, and B's ctx with A's projectId, reads and changes nothing of A", async () => {
    const before = await dumpA();
    const variants = [{ userId: 'user-b' }, { userId: 'user-b', projectId: a.projectId }];
    const all = list();
    const problems: string[] = [];
    for (const creators of [false, true]) {
      for (const { name, c } of all.filter((x) => (x.c.expect === 'as-caller') === creators)) {
        for (const ctx of variants) {
          if (c.project && !ctx.projectId) continue;
          const got = await outcome(c, ctx);
          const tag = `${name} [${ctx.projectId ? 'forged project' : 'plain'}]`;
          if (c.expect === 'zero') {
            if (got instanceof Error || !isZero(got) || leaks(got).length) problems.push(`${tag}: expected zero, got ${got instanceof Error ? got.message : JSON.stringify(got)}`);
          } else if (c.expect === 'no-a') {
            if (got instanceof Error || leaks(got).length) problems.push(`${tag}: ${got instanceof Error ? got.message : 'leaks ' + leaks(got).join(',')}`);
          } else if (c.expect === 'as-caller') {
            if (got !== true) problems.push(`${tag}: creator did not store user B (${got instanceof Error ? got.message : String(got)})`);
          } else if (!(got instanceof RepoError) || got.code !== c.expect.slice('throws:'.length) || leaks(got.message).length) {
            problems.push(`${tag}: expected ${c.expect}, got ${got instanceof Error ? got.name + ':' + got.message : JSON.stringify(got)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(await dumpA()).toEqual(before);
  }, 120_000);

  it('D12(6) every table has a user_id column or a foreign-key path to a table that has one', async () => {
    const cols = await sql<{ t: string; c: string }>`select table_name as t, column_name as c from information_schema.columns where table_schema = ${s.schema}`.execute(s.db.kysely);
    const fks = await sql<{ child: string; parent: string }>`
      select cl.relname as child, pl.relname as parent from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid join pg_class pl on pl.oid = k.confrelid join pg_namespace n on n.oid = cl.relnamespace
      where k.contype = 'f' and n.nspname = ${s.schema}`.execute(s.db.kysely);
    const tables = [...new Set(cols.rows.map((r) => r.t))].filter((t) => t !== 'schema_migrations');
    const direct = new Set(cols.rows.filter((r) => r.c === 'user_id').map((r) => r.t));
    const reaches = (t: string, seen = new Set<string>()): boolean => {
      if (direct.has(t)) return true;
      if (seen.has(t)) return false;
      seen.add(t);
      return fks.rows.filter((f) => f.child === t).some((f) => reaches(f.parent, seen));
    };
    expect(tables.filter((t) => !reaches(t))).toEqual([]);
  });

  it('D12(7) a missing ctx is a TypeError and sends zero queries, for every function', async () => {
    let queries = 0;
    const counter: KyselyPlugin = { transformQuery: (args) => { queries++; return args.node; }, transformResult: async (args) => args.result };
    const counted: Db = { kysely: s.db.kysely.withPlugin(counter), close: async () => undefined };
    const repos = createRepositories(counted);
    const seen: string[] = [];
    for (const [d, o] of Object.entries(repos)) {
      if (d === 'system') continue;
      for (const [f, fn] of Object.entries(o) as [string, (...x: unknown[]) => Promise<unknown>][]) {
        for (const bad of [undefined, null, {}, { userId: '' }, { userId: '   ' }]) {
          await expect(fn(bad, {})).rejects.toThrowError(new TypeError('ctx.userId required'));
          seen.push(`${d}.${f}`);
        }
      }
    }
    for (const [d, o] of Object.entries(repos.system)) {
      for (const [f, fn] of Object.entries(o) as [string, (...x: unknown[]) => Promise<unknown>][]) {
        await expect(fn({ userId: 'user-a' }, 'x')).rejects.toBeInstanceOf(TypeError);
        seen.push(`system.${d}.${f}`);
      }
    }
    expect(queries).toBe(0);
    expect(seen.length).toBeGreaterThan(80);
  });

  it('D12(8) the system functions are exactly the allowlist of D13', () => {
    const got = Object.entries(s.repos.system).flatMap(([d, o]) => Object.keys(o).map((f) => `${d}.${f}`)).sort();
    expect(got).toEqual(SYSTEM_ALLOWLIST);
  });
});
