#!/usr/bin/env node
// One runnable example per decision id of agent/t1-1-workspace/DECISIONS.md. Plain Node, no dependencies.
// Prints `PASS D3 <label>` or `FAIL D3 <label> expected=<json> got=<json>` (or `SKIP`). Exit 1 if any FAIL.
// Usage: node agent/t1-1-workspace/checks.mjs [D#]      (env CTC_ROOT = another checkout, CTC_CHECKS_FAST=1 skips slow steps)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CTC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAST = process.env.CTC_CHECKS_FAST === '1';
const only = process.argv[2];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t11-checks-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
let failed = 0;

function sh(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, {
    cwd: o.cwd ?? ROOT, input: o.input, encoding: 'utf8', timeout: o.timeout ?? 240_000, maxBuffer: 64 << 20,
    env: { ...process.env, ...o.env },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function check(id, label, fn) {
  if (only && only !== id) return;
  let exp, got;
  try { [exp, got] = fn(); } catch (e) { exp = 'no exception'; got = `threw: ${String(e?.message ?? e).split('\n')[0]}`; }
  if (got === 'SKIP') { console.log(`SKIP ${id} ${label}`); return; }
  if (JSON.stringify(exp) === JSON.stringify(got)) console.log(`PASS ${id} ${label}`);
  else { failed++; console.log(`FAIL ${id} ${label} expected=${JSON.stringify(exp)} got=${JSON.stringify(got)}`); }
}

// ---- config loader harness: write a fixture config dir, run loadConfig in a child, read JSON back
const MOD = path.join(ROOT, 'packages/shared/src/env/index.ts');
const RUN = path.join(TMP, 'run.mts');
fs.writeFileSync(RUN, `
const [dir, envJson, home] = process.argv.slice(2);
const env = JSON.parse(envJson); const before = JSON.stringify(env);
try {
  const mod = await import(process.env.CTC_MOD);
  const config = mod.loadConfig({ dir, env, home });
  console.log(JSON.stringify({ ok: true, config, envSame: JSON.stringify(env) === before }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, name: e?.constructor?.name, message: String(e?.message), issues: e?.issues, envSame: JSON.stringify(env) === before }));
}`);
let n = 0;
function cfgDir(files = {}) {
  const d = path.join(TMP, `c${n++}`, 'config');
  fs.mkdirSync(d, { recursive: true });
  for (const f of ['models', 'retrieval', 'server']) fs.writeFileSync(path.join(d, `${f}.yaml`), files[f] ?? '');
  if (files.ctc !== undefined) fs.writeFileSync(path.join(d, 'ctc.yaml'), files.ctc);
  if (files.skip) for (const f of files.skip) fs.rmSync(path.join(d, `${f}.yaml`));
  return d;
}
function load(dir, env = {}, home = '/h', cwd = ROOT) {
  const r = sh('node', [RUN, dir, JSON.stringify(env), home], { cwd, env: { CTC_MOD: MOD } });
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return { ok: false, name: 'RunnerCrash', message: r.out.split('\n').find(Boolean) ?? '', issues: [] }; }
}
const pairs = (r) => (r.issues ?? []).map((i) => [i.file, i.path]);

// ---- D0 purpose, packages
check('D0', 'five packages, no dashboard, no root', () => {
  const r = sh('pnpm', ['-r', 'ls', '--depth', '-1', '--json']);
  const names = JSON.parse(r.stdout || '[]').map((p) => p.name).sort();
  return [['@ctc/cli', '@ctc/core', '@ctc/shared', '@ctc/web', '@ctc/worker'], names];
});
check('D0', 'apps import @ctc/shared and @ctc/core through the workspace link', () => {
  const out = ['web', 'worker', 'cli'].map((a) => JSON.parse(read(`apps/${a}/package.json`)).dependencies ?? {})
    .map((d) => [d['@ctc/shared'], d['@ctc/core']]);
  return [Array(3).fill(['workspace:*', 'workspace:*']), out];
});

// ---- D1 trust
check('D1', 'YAML alias refused, as a ConfigError on that file', () => {
  const r = load(cfgDir({ server: 'jobs: &j {timeout_s: 60}\nhistory: *j\n' }));
  return [[false, 'ConfigError', 'config/server.yaml', true], [r.ok, r.name, r.issues?.[0]?.file, /alias/i.test(r.message ?? '')]];
});
check('D1', 'a bad database_url is reported without echoing the password', () => {
  const r = load(cfgDir(), { CTC_DATABASE_URL: 'postgresql://u:SECRETPW@h:badport/db' });
  return [[false, true, false], [r.ok, (r.message ?? '').includes('env CTC_DATABASE_URL: '), (r.message ?? '').includes('SECRETPW')]];
});

// ---- D2 versions and limits
check('D2', 'node and pnpm pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  return [{ node: '22.22.1', pm: 'pnpm@10.34.5', engines: ['>=22.22.1 <23', '>=10.34.5 <11'] },
    { node: read('.node-version').trim(), pm: pkg.packageManager, engines: [pkg.engines?.node, pkg.engines?.pnpm] }];
});
check('D2', 'library majors', () => {
  const v = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p, 'package.json'), 'utf8')).version;
  return [{ ts: '6.0', vitest: '4', eslint: '10', zod: '4' }, {
    ts: v('node_modules/typescript').split('.').slice(0, 2).join('.'), vitest: v('node_modules/vitest').split('.')[0],
    eslint: v('node_modules/eslint').split('.')[0], zod: v('packages/shared/node_modules/zod').split('.')[0],
  }];
});
check('D2', 'lint fails on warnings; npmrc exact', () => {
  const lint = JSON.parse(read('packages/core/package.json')).scripts?.lint ?? '';
  return [[true, true, true], [lint.includes('--max-warnings 0'), /save-exact\s*=\s*true/.test(read('.npmrc')), /engine-strict\s*=\s*true/.test(read('.npmrc'))]];
});
check('D2', 'bounds: port 0 and shrink_guard 1.5 are issues with their paths', () => {
  const r = load(cfgDir({ server: 'port: 0\n', ctc: 'graph: {shrink_guard: 1.5}\n' }));
  return [[['config/ctc.yaml', 'graph.shrink_guard'], ['config/server.yaml', 'port']], pairs(r)];
});

// ---- D3 output formats
check('D3', 'defaults of an empty config dir', () => {
  const c = load(cfgDir(), {}, '/h').config ?? {};
  return [{
    db: null, sock: '/h/.claudethecaller/ctc.sock', port: 18310, text: 'skillret', rw: 0, guard: 0.2, bands: [0.95, 0.85],
    fails: 3, codex: ['codex', 'exec', '--json'], ctx: 600, floor: 0.3, roots: ['/h/.claude'], spool: '/h/.claudethecaller/spool',
  }, {
    db: c.database_url, sock: c.socket, port: c.port, text: c.embed?.text, rw: c.ranking?.rerank_weight, guard: c.graph?.shrink_guard,
    bands: [c.memory?.bands?.noop, c.memory?.bands?.update], fails: c.runner?.max_failures, codex: c.runner?.agents?.codex?.argv,
    ctx: c.cache?.ttl?.ctx, floor: c.graph_push?.floor, roots: c.library?.roots, spool: c.spool?.dir,
  }];
});
check('D3', 'defaults fill inside a partly given section (cache.ttl)', () => {
  const c = load(cfgDir({ server: 'cache: {ttl: {emb: 5, bundle: 7}}\n' })).config ?? {};
  return [[5, 7, 600, 256], [c.cache?.ttl?.emb, c.cache?.ttl?.bundle, c.cache?.ttl?.ctx, c.cache?.l1_size]];
});
check('D3', 'error line format: file, dotted path, message', () => {
  const r = load(cfgDir({ server: 'runner: {max_failures: "x"}\n' }));
  return [['config/server.yaml', 'runner.max_failures', true], [r.issues?.[0]?.file, r.issues?.[0]?.path, (r.message ?? '').startsWith('config/server.yaml: runner.max_failures: ')]];
});
check('D3', 'list item paths use [i]', () => {
  const r = load(cfgDir({ ctc: 'graph: {languages: [ts, 5]}\n' }));
  return [[['config/ctc.yaml', 'graph.languages[1]']], pairs(r)];
});
check('D3', 'env overrides beat YAML; empty env ignored; bad env named', () => {
  const ok = load(cfgDir({ server: 'port: 18310\nmode: local\n' }), { CTC_PORT: '19999', CTC_MODE: 'shared', CTC_REDIS_URL: 'redis://h:1/2', CTC_DATABASE_URL: 'postgresql://u:p@h:5432/d', CTC_LLM: '' }).config ?? {};
  const bad = load(cfgDir(), { CTC_PORT: 'abc' });
  return [[19999, 'shared', 'redis://h:1/2', 'postgresql://u:p@h:5432/d', 'openai:http://127.0.0.1:18302/v1:qwen2.5-3b', 'env CTC_PORT: '],
    [ok.port, ok.mode, ok.redis_url, ok.database_url, ok.llm, (bad.message ?? '').slice(0, 14)]];
});
check('D3', '~ expands to home; ~user stays; runner.worktree.dir stays relative', () => {
  const c = load(cfgDir({ server: 'socket: ~/s.sock\nclaude_home: ~bob/x\n', ctc: 'library: {roots: ["~", "~/p"]}\n' }), {}, '/home2').config ?? {};
  return [['/home2/s.sock', '~bob/x', ['/home2', '/home2/p'], '.ctc/wt'], [c.socket, c.claude_home, c.library?.roots, c.runner?.worktree?.dir]];
});
check('D3', '@ctc/shared exports map', () => {
  const e = JSON.parse(read('packages/shared/package.json')).exports;
  return [{ '.': './src/index.ts', './*': './src/*/index.ts' }, e];
});

// ---- D4 bad input
check('D4', 'all issues at once, sorted by file then path', () => {
  const r = load(cfgDir({ server: 'port: 0\n', retrieval: 'k: "five"\n', ctc: 'graph: {shrink_gaurd: 0.1}\n' }));
  return [[false, [['config/ctc.yaml', 'graph.shrink_gaurd'], ['config/retrieval.yaml', 'k'], ['config/server.yaml', 'port']]], [r.ok, pairs(r)]];
});
check('D4', 'missing required file; yaml syntax error; duplicate key across files', () => {
  const miss = load(cfgDir({ skip: ['models'] }));
  const syn = load(cfgDir({ server: 'port: [\n' }));
  const dup = load(cfgDir({ server: 'mode: local\n', ctc: 'mode: shared\n' }));
  return [[[['config/models.yaml', '(file)']], true, true], [pairs(miss), (syn.message ?? '').includes('config/server.yaml: (file): yaml: '), dup.ok === false && (dup.message ?? '').includes('mode')]];
});
check('D4', 'unknown key: top level and inside a 007 section', () => {
  const r = load(cfgDir({ ctc: 'grpah: {x: 1}\nmemory: {half_life: 3}\n' }));
  return [[['config/ctc.yaml', 'grpah'], ['config/ctc.yaml', 'memory.half_life']], pairs(r)];
});

// ---- D5 odd but harmless
check('D5', 'python-era keys kept under legacy; bare off is "off"', () => {
  const c = load(cfgDir({ retrieval: 'gate: {kind: off}\nblend: {prompt: 0.6}\nmemory_in_query: false\n', server: 'history: {skip_projects: []}\njobs: {timeout_s: 60}\n' })).config ?? {};
  return [['off', 0.6, false, [], 60], [c.legacy?.gate?.kind, c.legacy?.blend?.prompt, c.legacy?.memory_in_query, c.legacy?.history?.skip_projects, c.legacy?.jobs?.timeout_s]];
});
check('D5', 'the real config/ dir loads with zero issues', () => {
  const r = load(path.join(ROOT, 'config'), {}, '/h');
  const c = r.config ?? {};
  return [[true, 'skillret', 0, '2.1.306', 18310], [r.ok, c.embed?.text, c.ranking?.keyword_rrf_weight, c.runner?.claude_version, c.port]];
});
check('D5', 'empty files and no ctc.yaml are valid; quoted number is an issue', () => {
  const okEmpty = load(cfgDir({ models: '# only a comment\n', retrieval: 'null\n' })).ok;
  const q = load(cfgDir({ server: 'port: "18310"\n' }));
  return [[true, [['config/server.yaml', 'port']]], [okEmpty, pairs(q)]];
});

// ---- D6 must never
check('D6', 'junk files give ConfigError (or a valid empty mapping), never another crash', () => {
  const big = '0'.repeat(5 << 20);
  const outcomes = [
    cfgDir({ models: '\u0000\u0001ÿ' }), cfgDir({ models: '- a\n- b\n' }), cfgDir({ models: '1: 2\n' }),
    cfgDir({ server: 'port:\t1\n' }), cfgDir({ server: `x: ${big}\n` }),
    (() => { const d = cfgDir(); fs.rmSync(path.join(d, 'models.yaml')); fs.mkdirSync(path.join(d, 'models.yaml')); return d; })(),
  ].map((d) => { const r = load(d); return r.ok ? 'ok' : r.name; });
  return [Array(6).fill('ConfigError'), outcomes];
});
check('D6', 'env argument untouched; same input gives the same output; no secret', () => {
  const env = { CTC_PORT: 'zz', CTC_DATABASE_URL: 'postgresql://u:SECRETPW@h:5432/d' };
  const d = cfgDir({ server: 'port: 0\nmode: x\n' });
  const a = load(d, env), b = load(d, env);
  return [[true, true, false, 'ConfigError'], [a.envSame, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a).includes('SECRETPW'), a.name]];
});
check('D6', 'eslint ban is not bypassed by file extension', () => {
  const hits = ['apps/web/src/a.ts', 'apps/web/src/a.mts', 'apps/web/src/a.js', 'apps/web/src/a.mjs'].map((f) => banned(f, "import pg from 'pg';\nexport const x = pg;\n"));
  return [Array(4).fill(true), hits];
});

// ---- D7 non-goals
check('D7', 'loader reads no .env, no cwd; no pg/dotenv in env module', () => {
  const cwd = path.join(TMP, 'cwdenv'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, '.env'), 'CTC_PORT=19999\n');
  const port = load(cfgDir(), {}, '/h', cwd).config?.port;
  const src = fs.existsSync(path.join(ROOT, 'packages/shared/src/env')) ? fs.readdirSync(path.join(ROOT, 'packages/shared/src/env')).filter((f) => !f.includes('.test.')).map((f) => read(`packages/shared/src/env/${f}`)).join('\n') : '';
  return [[18310, false], [port, /from ['"](pg|dotenv|kysely)['"]/.test(src)]];
});
check('D7', 'no forbidden dependencies yet', () => {
  const deps = ['apps/web', 'apps/worker', 'apps/cli', 'packages/shared', 'packages/core'].flatMap((p) => Object.keys({ ...JSON.parse(read(`${p}/package.json`)).dependencies }));
  return [[], deps.filter((d) => /^(pg|kysely|fastify|bullmq|ioredis|@modelcontextprotocol\/sdk|dotenv)$/.test(d))];
});

// ---- D8 silence rule
check('D8', 'unknown keys inside legacy sections and cache are kept, not rejected', () => {
  const c = load(cfgDir({ server: 'cache: {semantic_min_cos: 0.95}\njobs: {whatever: 1}\n' })).config ?? {};
  return [[0.95, 1], [c.cache?.semantic_min_cos, c.legacy?.jobs?.whatever]];
});

// ---- D9 scope: layout
check('D9', 'every package has package.json, tsconfig, src/index.ts, a test, the three scripts', () => {
  const bad = [];
  for (const p of ['apps/web', 'apps/worker', 'apps/cli', 'packages/shared', 'packages/core']) {
    if (!exists(`${p}/package.json`)) { bad.push(`${p}: no package.json`); continue; }
    const j = JSON.parse(read(`${p}/package.json`));
    if (j.type !== 'module' || j.private !== true) bad.push(`${p}: type/private`);
    if (!/^eslint .*\./.test(j.scripts?.lint ?? '') || !(j.scripts?.typecheck ?? '').startsWith('tsc') || !(j.scripts?.test ?? '').startsWith('vitest')) bad.push(`${p}: scripts`);
    if (!exists(`${p}/tsconfig.json`) || !exists(`${p}/src/index.ts`)) bad.push(`${p}: tsconfig/index`);
    const tests = sh('git', ['ls-files', '--others', '--cached', '--exclude-standard', `${p}/src`]).stdout.split('\n').filter((f) => f.endsWith('.test.ts'));
    if (!tests.length) bad.push(`${p}: no test`);
  }
  return [[], bad];
});

// ---- D10 tsconfig flags
check('D10', 'strict flags catch the planted errors', () => {
  const d = path.join(TMP, 'ts'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(d, 'f.ts'), `const a: string = 1;\nconst arr: number[] = [];\nconst b: number = arr[0];\nenum E { A }\nconst o: { p?: number } = { p: undefined };\nexport { a, b, E, o };\n`);
  fs.writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ extends: path.join(ROOT, 'tsconfig.base.json'), compilerOptions: { types: [] }, files: ['f.ts'] }));
  const r = sh('pnpm', ['-C', 'packages/shared', 'exec', 'tsc', '-p', path.join(d, 'tsconfig.json'), '--noEmit']);
  const codes = [...new Set([...r.out.matchAll(/error (TS\d+)/g)].map((m) => m[1]))].sort();
  return [['TS1294', 'TS2322', 'TS2375'], codes];
});

// ---- D11 ESLint ban
function banned(file, code) {
  const abs = path.join(ROOT, file);
  const pkg = file.split('/').slice(0, 2).join('/');
  const r = sh('pnpm', ['-C', pkg, 'exec', 'eslint', '--stdin', '--stdin-filename', abs, '--format', 'json'], { input: code });
  let msgs = [];
  try { msgs = JSON.parse(r.stdout)[0]?.messages ?? []; } catch { return `eslint crashed: ${r.out.split('\n')[0]}`; }
  return msgs.some((m) => (m.message ?? '').includes('packages/shared/src/repositories'));
}
const CASES = [
  ['apps/web/src/x.ts', "import pg from 'pg';\nexport const x = pg;\n", true, 'static import pg'],
  ['packages/core/src/x.ts', "import { Kysely } from 'kysely';\nexport const x = Kysely;\n", true, 'static import kysely'],
  ['packages/core/src/x.ts', "import { sql } from 'kysely/helpers/postgres';\nexport const x = sql;\n", true, 'kysely subpath'],
  ['packages/core/src/x.ts', "import pgvector from 'pgvector/pg';\nexport const x = pgvector;\n", true, 'pgvector subpath'],
  ['apps/worker/src/x.ts', "export { Pool } from 'pg';\n", true, 'export from pg'],
  ['apps/web/src/x.ts', "export const m = await import('pg');\n", true, 'dynamic import'],
  ['apps/cli/src/x.mjs', "const pg = require('pg');\nexport default pg;\n", true, 'require'],
  ['apps/web/src/x.test.ts', "import pg from 'pg';\nexport const x = pg;\n", true, 'test files get no exception'],
  ['packages/shared/src/repositories/x.ts', "import pg from 'pg';\nexport const x = pg;\n", false, 'allowed in repositories'],
  ['packages/shared/src/repositories/admin/x.ts', "import pg from 'pg';\nimport { Kysely } from 'kysely';\nexport const x = [pg, Kysely];\n", false, 'allowed in repositories/admin'],
  ['apps/web/src/x.ts', "import { z } from 'zod';\nexport const x = z;\n", false, 'zod is fine'],
];
for (const [file, code, want, label] of CASES) check('D11', label, () => [want, banned(file, code)]);

// ---- D12 CI, check.sh, dashboard
check('D12', 'ci.yml has the ts job; dashboard job unchanged', () => {
  const ci = read('.github/workflows/ci.yml');
  const ts = ci.split(/^  (?=[a-z-]+:\s*$)/m).find((b) => /pnpm -r lint/.test(b)) ?? '';
  return [[true, true, true, true, true, true], [/pnpm -r typecheck/.test(ts), /pnpm -r test/.test(ts), /pnpm install --frozen-lockfile/.test(ts),
    /node-version-file: \.node-version/.test(ts), /pnpm -C dashboard install --frozen-lockfile/.test(ci), /pnpm -C dashboard build/.test(ci)]];
});
check('D12', 'check.sh runs the three pnpm -r commands; dashboard lines kept', () => {
  const s = read('scripts/check.sh');
  return [[true, true, true, true, true], ['pnpm -r lint', 'pnpm -r typecheck', 'pnpm -r test', 'pnpm -C dashboard install --frozen-lockfile', 'pnpm -C dashboard build'].map((x) => s.includes(x))];
});
check('D12', 'dashboard is standalone: own workspace file, package and lockfile untouched', () => {
  const diff = sh('git', ['diff', '--stat', 'HEAD', '--', 'dashboard/package.json', 'dashboard/pnpm-lock.yaml']).stdout.trim();
  return [['packages: []', ''], [read('dashboard/pnpm-workspace.yaml').replace(/#.*\n/g, '').trim(), diff]];
});
check('D12', 'pnpm -C dashboard install --frozen-lockfile still installs the dashboard', () => {
  if (FAST) return [0, 'SKIP'];
  const r = sh('pnpm', ['-C', 'dashboard', 'install', '--frozen-lockfile', '--prefer-offline']);
  return [[0, true, false], [r.code, exists('dashboard/node_modules/.bin/vite'), exists('pnpm-lock.yaml') && /dashboard/.test(read('pnpm-lock.yaml'))]];
});

// ---- D13 tests
check('D13', 'pnpm -r test passes with a test in each of the five packages', () => {
  const r = sh('pnpm', ['-r', 'test']);
  return [[0, 5], [r.code, (r.out.match(/Tests\s+\d+ passed/g) ?? []).length]];
});

console.log(failed ? `checks: ${failed} FAIL` : 'checks: all PASS');
process.exit(failed ? 1 : 0);
