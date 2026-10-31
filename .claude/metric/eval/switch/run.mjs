#!/usr/bin/env node
// Gate runner of the switch-over: runs every gate of spec §7 on the dev-instance environment and records one row per gate.
// Called from: a human (`node .claude/metric/eval/switch/run.mjs [--list] [--only a,b] [--out file]`) and agent/t7-1-switch/selfcheck.py.
// Why it exists: the gates are Vitest files and one shell script spread over six packages; the switch is only done when all of them are green at once, with the
// same environment (CTC_HOME under .ctc-dev, web port 18410, the scratch Postgres and Redis), and the result must be a file a reviewer can read.
// Deliberately NOT done: starting or stopping services, anything outside this repository and the scratch services, the dashboard end-to-end gate (reported as
// not run, owner rule O12), editing a test to make a gate pass, retries of a failed gate.
// Green means: exit 0 and, under the top-level describe named like the gate, at least one passed and no failed, skipped, pending or todo test (a skipped
// describe is red, so a missing strict flag cannot turn a gate green). `ci` is green on exit 0 of scripts/check.sh.
// Output: .ctc-dev/eval/switch.json ({startedAt, head, node, rows}); after a full run with the default --out also the Results tables of
// .claude/metric/eval/switch.md and ci.md. Exit 0 when no row is `fail`, 1 otherwise, 2 for a bad argument or a database that is not the scratch one.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../../../', import.meta.url).pathname);
const SCRATCH_PG = /^postgres(?:ql)?:\/\/[^@]*@127\.0\.0\.1:18304\//;
const REDIS = 'redis://127.0.0.1:18395';
const NOT_RUN_REASON = 'O12: no frontend spec (spec §10), the dashboard rework is not built';
/** Seconds per gate: a Vitest file finishes in minutes; `ci` runs the whole check script (installs, builds, every suite) and gets longer. Chosen by judgment. */
const TIMEOUT_S = { vitest: 1800, ci: 7200 };

const GATES = [
  { gate: 'tenancy', area: 'System', file: 'packages/shared/src/repositories/tenancy.test.ts' },
  { gate: 'failopen', area: 'System', file: 'apps/web/src/pre/failopen.int.test.ts' },
  { gate: 'ci', area: 'System', kind: 'ci' },
  { gate: 'graph.ids', area: 'F1', file: 'packages/core/src/graph/graph.ids.test.ts' },
  { gate: 'graph.resolve', area: 'F1', file: 'packages/core/src/graph/graph.resolve.test.ts' },
  { gate: 'graph.incremental', area: 'F1', file: 'apps/worker/src/graph/graph.incremental.test.ts' },
  { gate: 'graph.query', area: 'F1', file: 'apps/web/src/graph/graph.query.int.test.ts' },
  { gate: 'suggest.latency', area: 'F1', file: 'apps/web/src/suggest/suggest.latency.int.test.ts', env: { CTC_GATE_SUGGEST: '1' } },
  { gate: 'suggest.context', area: 'F1', file: 'apps/web/src/suggest/suggest.context.int.test.ts', env: { CTC_GATE_SUGGEST: '1' } },
  { gate: 'library.version', area: 'F2', file: 'apps/worker/src/library/library.version.test.ts' },
  { gate: 'library.mcp', area: 'F2', file: 'apps/web/src/library/library.mcp.int.test.ts' },
  { gate: 'library.override', area: 'F2', file: 'apps/web/src/library/library.override.int.test.ts' },
  { gate: 'suggest.skills', area: 'F2', file: 'apps/web/src/skills/suggest.skills.int.test.ts', env: { CTC_GATE_SUGGEST_SKILLS: '1' } },
  { gate: 'memory.spool', area: 'F3', file: 'apps/web/src/spool/memory.spool.int.test.ts' },
  { gate: 'memory.idempotent', area: 'F3', file: 'apps/worker/src/memory/memory.idempotent.int.test.ts' },
  { gate: 'memory.bands', area: 'F3', file: 'apps/worker/src/memory/memory.bands.int.test.ts' },
  { gate: 'memory.context', area: 'F3', file: 'apps/web/src/memory/memory.context.int.test.ts' },
  { gate: 'memory.recall', area: 'F3', file: 'apps/web/src/memory/memory.recall.int.test.ts' },
  { gate: 'runner.lifecycle', area: 'F4', file: 'apps/web/src/runs/runner.lifecycle.int.test.ts' },
  { gate: 'runner.crash', area: 'F4', file: 'apps/worker/src/runner/runner.crash.int.test.ts' },
  { gate: 'runner.fanout', area: 'F4', file: 'apps/worker/src/runner/runner.fanout.int.test.ts' },
  { gate: 'runner.idempotent', area: 'F4', file: 'apps/web/src/runs/runner.idempotent.int.test.ts' },
  { gate: 'runner.md', area: 'F4', file: 'apps/worker/src/runner/runner.md.int.test.ts' },
  { gate: 'dashboard-e2e', area: 'Dashboard', kind: 'not_run' },
  { gate: 'dev-instance', area: 'Switch', file: 'apps/web/src/server/switch.live.int.test.ts', describe: 'switch.live' },
];
const NAMES = GATES.map((g) => g.gate);

if (process.argv.includes('--list')) {
  process.stdout.write(`${NAMES.join('\n')}\n`);
  process.exit(0);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const pg = process.env.CTC_SCRATCH_PG_URL ?? '';
if (!SCRATCH_PG.test(pg)) usage('CTC_SCRATCH_PG_URL must be postgres://...@127.0.0.1:18304/<db> (the scratch Postgres); nothing was run');
const onlyArg = arg('--only');
const only = onlyArg === undefined ? undefined : onlyArg.split(',').filter(Boolean);
const unknown = (only ?? []).filter((n) => !NAMES.includes(n));
if (unknown.length > 0) usage(`unknown gate(s): ${unknown.join(', ')}; run with --list`);
if (only !== undefined && only.length === 0) usage('--only needs at least one gate name');
const defaultOut = path.join(ROOT, '.ctc-dev/eval/switch.json');
const out = path.resolve(arg('--out') ?? defaultOut);
const selected = GATES.filter((g) => only === undefined || only.includes(g.gate));

/** Env for every gate: the dev instance and the scratch services; no other CTC_* value of the caller's shell reaches a gate. */
function envFor(extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CTC_')));
  return {
    ...base, CTC_HOME: path.join(ROOT, '.ctc-dev'), CTC_PORT: '18410', CTC_SCRATCH_PG_URL: pg, CTC_TEST_DATABASE_URL: pg, CTC_TEST_ADMIN_URL: pg,
    CTC_SCRATCH_REDIS_URL: REDIS, CTC_SWITCH_RUNNING: '1', ...extra,
  };
}

function runUnderTimeout(seconds, argv, env) {
  const t0 = Date.now();
  // stderr is merged into stdout inside the shell so that the tail of `text` is the real end of the output, in order
  const r = spawnSync('timeout', ['-k', '15', String(seconds), 'bash', '-c', 'exec "$@" 2>&1', '_', ...argv], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, text: r.stdout ?? '', ms: Date.now() - t0 };
}

/** Counts of the assertions under the top-level describe `name` in a Vitest JSON report. */
function countsOf(report, name) {
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if ((a.ancestorTitles ?? [])[0] !== name) continue;
      if (a.status === 'passed') c.passed++;
      else if (a.status === 'failed') c.failed++;
      else c.skipped++;
    }
  }
  return c;
}

function vitestRow(g) {
  const command = `pnpm exec vitest run ${g.file} --reporter=json`;
  const row = { gate: g.gate, area: g.area, command, status: 'fail', passed: 0, failed: 0, skipped: 0, ms: 0 };
  if (!fs.existsSync(path.join(ROOT, g.file))) return { ...row, reason: 'file missing' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-run-'));
  const file = path.join(tmp, 'report.json');
  try {
    const r = runUnderTimeout(TIMEOUT_S.vitest, ['pnpm', 'exec', 'vitest', 'run', g.file, '--reporter=json', `--outputFile=${file}`], envFor(g.env));
    row.ms = r.ms;
    if (!fs.existsSync(file)) return { ...row, reason: `no report (exit ${r.code}): ${r.text.slice(-300)}` };
    const counts = countsOf(JSON.parse(fs.readFileSync(file, 'utf8')), g.describe ?? g.gate);
    Object.assign(row, counts);
    if (r.code !== 0) return { ...row, reason: `exit ${r.code}` };
    if (counts.passed < 1) return { ...row, reason: `no passed test under describe '${g.describe ?? g.gate}'` };
    if (counts.failed > 0 || counts.skipped > 0) return { ...row, reason: `${counts.failed} failed, ${counts.skipped} skipped` };
    return { ...row, status: 'pass' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ciRow(g) {
  const row = { gate: g.gate, area: g.area, command: 'bash scripts/check.sh', status: 'fail', passed: 0, failed: 0, skipped: 0, ms: 0 };
  const r = runUnderTimeout(TIMEOUT_S.ci, ['bash', 'scripts/check.sh'], envFor({ CTC_DATABASE_URL: pg, CTC_REDIS_URL: `${REDIS}/0` }));
  row.ms = r.ms;
  fs.mkdirSync(path.join(ROOT, '.ctc-dev/eval'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.ctc-dev/eval/ci.log'), r.text);
  for (const m of r.text.matchAll(/^(?:\S+ test:)?\s*Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?/gm)) {
    row.failed += Number(m[1] ?? 0);
    row.passed += Number(m[2]);
    row.skipped += Number(m[3] ?? 0);
  }
  if (r.code === 0) return { ...row, status: 'pass' };
  return { ...row, reason: `exit ${r.code}; full output in .ctc-dev/eval/ci.log: ${r.text.slice(-300).replace(/\s+/g, ' ')}` };
}

function runGate(g) {
  if (g.kind === 'not_run') return { gate: g.gate, area: g.area, command: 'n/a', status: 'not_run', passed: 0, failed: 0, skipped: 0, ms: 0, reason: NOT_RUN_REASON };
  return g.kind === 'ci' ? ciRow(g) : vitestRow(g);
}

/**
 * Removes the keys that test namespaces of this and earlier tasks leave in the scratch Redis (their tests use private, random namespaces and do not all remove
 * them; the embedding caches live 7 days). The T1.4 rate-limit test finds its key with ONE `SCAN ... COUNT 1000`, which misses it once the database holds more than
 * about a thousand keys, so a polluted scratch Redis turns the `ci` gate red at random. Only keys that start with a test prefix are touched.
 */
const TEST_PREFIXES = ['ctc_t51_', 'ctc_t52_', 't14', 'v14r', 't71'];
async function cleanScratchRedis() {
  const { Redis } = createRequire(path.join(ROOT, 'packages/shared/package.json'))('ioredis');
  const redis = new Redis(`${REDIS}/0`, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    for (const prefix of TEST_PREFIXES) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } catch {
    // the scratch Redis being down is reported by the gates that need it
  } finally {
    redis.disconnect();
  }
}

await cleanScratchRedis();
const rows = [];
const startedAt = new Date().toISOString();
for (const g of selected) {
  const row = runGate(g);
  rows.push(row);
  process.stdout.write(`${row.status.padEnd(7)} ${row.gate.padEnd(18)} ${row.passed}/${row.failed}/${row.skipped} ${row.ms} ms${row.reason ? `  ${row.reason.slice(0, 160)}` : ''}\n`);
}

await cleanScratchRedis();
const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ startedAt, head, node: process.version, rows }, null, 2)}\n`);

const between = (text, table) => text.replace(/<!-- results:start -->[\s\S]*?<!-- results:end -->/, `<!-- results:start -->\n${table}\n<!-- results:end -->`);
if (only === undefined && out === defaultOut) {
  const md = path.join(ROOT, '.claude/metric/eval/switch.md');
  const table = [
    '| gate | area | status | passed | failed | skipped | ms |', '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((r) => `| ${r.gate} | ${r.area} | ${r.status} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.ms} |`),
  ].join('\n');
  fs.writeFileSync(md, between(fs.readFileSync(md, 'utf8'), table));
  const ci = rows.find((r) => r.gate === 'ci');
  if (ci) {
    const ciMd = path.join(ROOT, '.claude/metric/eval/ci.md');
    const exit = ci.status === 'pass' ? 0 : 1;
    const line = ['| command | exit | passed tests | ms | date |', '| --- | ---: | ---: | ---: | --- |', `| bash scripts/check.sh | ${exit} | ${ci.passed} | ${ci.ms} | ${startedAt.slice(0, 10)} |`].join('\n');
    fs.writeFileSync(ciMd, between(fs.readFileSync(ciMd, 'utf8'), line));
  }
}
process.exit(rows.some((r) => r.status === 'fail') ? 1 : 0);
