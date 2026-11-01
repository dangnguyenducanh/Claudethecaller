import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, loadConfigOrExit } from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'ctc-env-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function fixture(files: Partial<Record<'models' | 'retrieval' | 'server' | 'ctc', string>> = {}): string {
  const dir = join(root, `c${n++}`);
  mkdirSync(dir);
  for (const name of ['models', 'retrieval', 'server'] as const) writeFileSync(join(dir, `${name}.yaml`), files[name] ?? '');
  if (files.ctc !== undefined) writeFileSync(join(dir, 'ctc.yaml'), files.ctc);
  return dir;
}

const HOME = '/home/test';
const load = (dir: string, env: Record<string, string | undefined> = {}) => loadConfig({ dir, env, home: HOME });

function issuesOf(dir: string, env: Record<string, string | undefined> = {}): ConfigError['issues'] {
  try {
    load(dir, env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected a ConfigError');
}

describe('defaults (D3f)', () => {
  it('an empty config dir gives today\'s values', () => {
    const c = load(fixture());
    expect(c).toMatchObject({
      embed_url: 'http://127.0.0.1:18300',
      rerank_url: 'http://127.0.0.1:18301',
      embedding_dim: 1024,
      timeout_s: 2,
      k: 5,
      rrf_k: 60,
      embed: { text: 'skillret', instruction: 'skillret', skillret_body_chars: 8000 },
      ranking: { keyword_rrf_weight: 0, rerank_weight: 0, fusion: 'rrf', score_w: 0.7, rerank_by: 'sigmoid' },
      graph_push: { floor: 0.3, max_pointers: 3, max_chars: 400, note_max: 3 },
      mode: 'local',
      port: 18310,
      database_url: null,
      redis_url: 'redis://127.0.0.1:18303/0',
      db_pool: { min: 3, max: 5 },
      cache: { l1_size: 256, redis_timeout_s: 0.02, down_for_s: 10, ttl: { emb: 604800, sug: 3600, ctx: 600, rl: 60 } },
      graph: { shrink_guard: 0.2, debounce_s: 3, query: { seeds: 3, depth: 2, hub_min: 50, budget_tokens: 2000 } },
      library: { default_label: 'production', dedup_cosine: 0.92, max_files: 200, max_bytes: 1048576 },
      memory: { context_chars: 10000, bands: { noop: 0.95, update: 0.85 }, rrf: { k: 60, per_leg: 100 } },
      runner: { max_failures: 3, max_visits: 3, setup: { policy: 'run' }, worktree: { dir: '.ctc/wt' } },
      legacy: {},
    });
    expect(c.runner.agents['codex']?.argv).toEqual(['codex', 'exec', '--json']);
    expect(c.graph.languages).toHaveLength(8);
  });

  it('fills defaults inside a partly given section', () => {
    const c = load(fixture({ server: 'cache: {ttl: {emb: 5, bundle: 7}}\n' }));
    expect([c.cache.ttl.emb, c.cache.ttl['bundle'], c.cache.ttl.ctx, c.cache.l1_size]).toEqual([5, 7, 600, 256]);
  });

  it('does not share state between calls', () => {
    const dir = fixture();
    load(dir).library.roots.push('x');
    expect(load(dir).library.roots).toEqual([`${HOME}/.claude`]);
  });
});

describe('bounds (D2)', () => {
  const ok = (yaml: string, file: 'server' | 'ctc' = 'server') => load(fixture({ [file]: yaml }));
  it('port 1 and 65535 are valid, 0 and 65536 are issues', () => {
    expect(ok('port: 1\n').port).toBe(1);
    expect(ok('port: 65535\n').port).toBe(65535);
    for (const bad of [0, 65536]) {
      expect(issuesOf(fixture({ server: `port: ${bad}\n` })).map((i) => i.path)).toEqual(['port']);
    }
  });
  it('fractions: 0 and 1 are valid, 1.5 and -0.1 are issues', () => {
    expect(ok('graph: {shrink_guard: 1}\n', 'ctc').graph.shrink_guard).toBe(1);
    expect(ok('graph: {shrink_guard: 0}\n', 'ctc').graph.shrink_guard).toBe(0);
    for (const bad of [1.5, -0.1]) {
      expect(issuesOf(fixture({ ctc: `graph: {shrink_guard: ${bad}}\n` }))).toEqual([
        { file: 'config/ctc.yaml', path: 'graph.shrink_guard', message: expect.any(String) },
      ]);
    }
  });
  it('counts are integers >= 1', () => {
    expect(ok('rate_limit_per_min: 1\n').rate_limit_per_min).toBe(1);
    for (const bad of ['0', '1.5']) {
      expect(issuesOf(fixture({ server: `rate_limit_per_min: ${bad}\n` })).map((i) => i.path)).toEqual(['rate_limit_per_min']);
    }
  });
  it('timeouts: models.timeout_s may be fractional but not 0', () => {
    expect(load(fixture({ models: 'timeout_s: 0.5\n' })).timeout_s).toBe(0.5);
    expect(issuesOf(fixture({ models: 'timeout_s: 0\n' })).map((i) => i.path)).toEqual(['timeout_s']);
  });
  it('ranking weights are numbers >= 0', () => {
    expect(load(fixture({ retrieval: 'ranking: {rerank_weight: 2.5}\n' })).ranking.rerank_weight).toBe(2.5);
    expect(issuesOf(fixture({ retrieval: 'ranking: {rerank_weight: -1}\n' })).map((i) => i.path)).toEqual(['ranking.rerank_weight']);
  });
  it('enums reject other values', () => {
    expect(issuesOf(fixture({ retrieval: 'embed: {text: other}\n' })).map((i) => i.path)).toEqual(['embed.text']);
    expect(issuesOf(fixture({ ctc: 'runner: {setup: {policy: maybe}}\n' })).map((i) => i.path)).toEqual(['runner.setup.policy']);
  });
});

describe('error format (D3e, D4)', () => {
  it('names file, dotted path and Zod\'s message', () => {
    const issues = issuesOf(fixture({ server: 'runner: {max_failures: "x"}\n' }));
    expect(issues).toEqual([{ file: 'config/server.yaml', path: 'runner.max_failures', message: 'Invalid input: expected number, received string' }]);
    expect(() => load(fixture({ server: 'runner: {max_failures: "x"}\n' }))).toThrow(
      'config/server.yaml: runner.max_failures: Invalid input: expected number, received string',
    );
  });
  it('list items use [i]', () => {
    expect(issuesOf(fixture({ ctc: 'graph: {languages: [ts, 5]}\n' })).map((i) => [i.file, i.path])).toEqual([['config/ctc.yaml', 'graph.languages[1]']]);
  });
  it('collects every issue, sorted by file then path', () => {
    const issues = issuesOf(fixture({ server: 'port: 0\n', retrieval: 'k: "five"\n', ctc: 'graph: {shrink_gaurd: 0.1}\n' }), { CTC_PORT: 'abc' });
    expect(issues.map((i) => [i.file, i.path])).toEqual([
      ['config/ctc.yaml', 'graph.shrink_gaurd'],
      ['config/retrieval.yaml', 'k'],
      ['config/server.yaml', 'port'],
      ['env', 'CTC_PORT'],
    ]);
    expect(issues[0]?.message).toBe('Unrecognized key');
  });
  it('message is the issue lines joined by newline; env lines start with "env "', () => {
    try {
      load(fixture({ models: 'zzz: 1\n' }), { CTC_PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message.split('\n')).toEqual([
        'config/models.yaml: zzz: Unrecognized key',
        'env CTC_PORT: Invalid input: expected number, received string',
      ]);
    }
  });
  it('missing required file, yaml syntax error, duplicate key across files', () => {
    const missing = fixture();
    rmSync(join(missing, 'models.yaml'));
    expect(issuesOf(missing)).toEqual([{ file: 'config/models.yaml', path: '(file)', message: 'not found' }]);
    const syntax = issuesOf(fixture({ server: 'port: [\n' }));
    expect(syntax[0]?.file).toBe('config/server.yaml');
    expect(syntax[0]?.path).toBe('(file)');
    expect(syntax[0]?.message).toMatch(/^yaml: .*line \d+, column \d+/);
    expect(issuesOf(fixture({ server: 'mode: local\n', ctc: 'mode: shared\n' }))).toEqual([
      { file: 'config/ctc.yaml', path: 'mode', message: 'Duplicate key (also in config/server.yaml)' },
    ]);
  });
  it('unknown key at top level and inside a 007 section', () => {
    expect(issuesOf(fixture({ ctc: 'grpah: {x: 1}\nmemory: {half_life: 3}\n' })).map((i) => i.path)).toEqual(['grpah', 'memory.half_life']);
  });
  it('a top-level `legacy` key is unknown', () => {
    expect(issuesOf(fixture({ server: 'legacy: {a: 1}\n' })).map((i) => i.path)).toEqual(['legacy']);
  });
});

describe('legacy and harmless input (D5, D8)', () => {
  it('Python-era keys are kept under legacy; bare off is the string "off"', () => {
    const c = load(
      fixture({
        retrieval: 'gate: {kind: off}\nblend: {prompt: 0.6}\nmemory_in_query: false\n',
        server: 'history: {skip_projects: []}\njobs: {timeout_s: 60, whatever: 1}\n',
      }),
    );
    expect(c.legacy).toEqual({
      gate: { kind: 'off' },
      blend: { prompt: 0.6 },
      memory_in_query: false,
      history: { skip_projects: [] },
      jobs: { timeout_s: 60, whatever: 1 },
    });
    expect(c).not.toHaveProperty('gate');
  });
  it('unknown cache keys are kept', () => {
    expect(load(fixture({ server: 'cache: {semantic_min_cos: 0.95}\n' })).cache['semantic_min_cos']).toBe(0.95);
  });
  it('python-era runner keys are accepted', () => {
    const c = load(fixture({ server: 'runner: {claude_version: "2.1.306", idle_wait_min: 15, poll_s: 1.5}\n' }));
    expect([c.runner.claude_version, c.runner.idle_wait_min, c.runner.poll_s]).toEqual(['2.1.306', 15, 1.5]);
  });
  it('empty, comment-only and null files are valid; ctc.yaml is optional', () => {
    expect(() => load(fixture({ models: '# only a comment\n', retrieval: 'null\n' }))).not.toThrow();
  });
  it('a quoted number is an issue, not coerced', () => {
    expect(issuesOf(fixture({ server: 'port: "18310"\n' })).map((i) => [i.file, i.path])).toEqual([['config/server.yaml', 'port']]);
  });
  it('the real config/ dir loads with zero issues', () => {
    const c = loadConfig({ dir: resolve(import.meta.dirname, '../../../../config'), env: {}, home: HOME });
    expect([c.embed.text, c.ranking.keyword_rrf_weight, c.runner.claude_version, c.port]).toEqual(['skillret', 0, '2.1.306', 18310]);
    expect(c.legacy['gate']).toEqual({ kind: 'off', margin_ratio: 1.5, min_p: 0.5 });
  });
  it('dir defaults to CTC_CONFIG_DIR, then to <repo root>/config', () => {
    const dir = fixture({ server: 'port: 19000\n' });
    expect(loadConfig({ env: { CTC_CONFIG_DIR: dir }, home: HOME }).port).toBe(19000);
    expect(loadConfig({ env: {}, home: HOME }).port).toBe(18310);
  });
});

describe('env overrides (D3g)', () => {
  it('env beats YAML; every variable maps to its key', () => {
    const c = load(fixture({ server: 'port: 18310\nmode: local\n' }), {
      CTC_PORT: '19999',
      CTC_MODE: 'shared',
      CTC_REDIS_URL: 'rediss://h:1/2',
      CTC_DATABASE_URL: 'postgres://u:p@h:5432/d',
      CTC_TEI_EMBED_URL: 'http://e',
      CTC_TEI_RERANK_URL: 'http://r',
      CTC_LLM: 'anthropic:x',
      CTC_SOCKET: '/s.sock',
      CTC_CLAUDE_HOME: '~/ch',
    });
    expect(c).toMatchObject({
      port: 19999, mode: 'shared', redis_url: 'rediss://h:1/2', database_url: 'postgres://u:p@h:5432/d',
      embed_url: 'http://e', rerank_url: 'http://r', llm: 'anthropic:x', socket: '/s.sock', claude_home: `${HOME}/ch`,
    });
  });
  it('env replaces a bad YAML value without reporting it', () => {
    expect(load(fixture({ server: 'port: 0\n' }), { CTC_PORT: '19999' }).port).toBe(19999);
  });
  it('an unset or empty variable does nothing', () => {
    expect(load(fixture(), { CTC_LLM: '', CTC_PORT: undefined }).port).toBe(18310);
  });
  it('a bad env value is named, and a bad port is a number problem', () => {
    expect(issuesOf(fixture(), { CTC_PORT: 'abc' })).toEqual([
      { file: 'env', path: 'CTC_PORT', message: 'Invalid input: expected number, received string' },
    ]);
    expect(issuesOf(fixture(), { CTC_PORT: '70000' }).map((i) => i.path)).toEqual(['CTC_PORT']);
    expect(issuesOf(fixture(), { CTC_MODE: 'cloud' }).map((i) => i.path)).toEqual(['CTC_MODE']);
  });
  it('url schemes are checked', () => {
    expect(issuesOf(fixture(), { CTC_DATABASE_URL: 'mysql://h/d' }).map((i) => i.path)).toEqual(['CTC_DATABASE_URL']);
    expect(issuesOf(fixture(), { CTC_REDIS_URL: 'http://h' }).map((i) => i.path)).toEqual(['CTC_REDIS_URL']);
    expect(issuesOf(fixture({ server: 'database_url: "postgresql://h"\nredis_url: "x"\n' })).map((i) => i.path)).toEqual(['redis_url']);
  });
});

describe('home expansion (D3h)', () => {
  it('~ and ~/ expand; ~user stays; runner.worktree.dir stays relative', () => {
    const c = loadConfig({
      dir: fixture({ server: 'socket: ~/s.sock\nclaude_home: ~bob/x\ntrash_dir: "~"\n', ctc: 'library: {roots: ["~", "~/p"]}\nspool: {dir: ~/sp}\n' }),
      env: {},
      home: '/home2',
    });
    expect([c.socket, c.claude_home, c.trash_dir, c.library.roots, c.spool.dir, c.runner.worktree.dir]).toEqual([
      '/home2/s.sock', '~bob/x', '/home2', ['/home2', '/home2/p'], '/home2/sp', '.ctc/wt',
    ]);
  });
});

describe('must never (D1, D6, D7)', () => {
  it('YAML aliases are refused as a ConfigError on that file', () => {
    const issues = issuesOf(fixture({ server: 'jobs: &j {timeout_s: 60}\nhistory: *j\n' }));
    expect(issues[0]?.file).toBe('config/server.yaml');
    expect(issues[0]?.message).toMatch(/alias/i);
  });
  it('a bad database_url is reported without echoing the password', () => {
    const message = (() => {
      try {
        load(fixture(), { CTC_DATABASE_URL: 'postgresql://u:SECRETPW@h:badport/db' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toContain('env CTC_DATABASE_URL: ');
    expect(message).not.toContain('SECRETPW');
    const fromYaml = issuesOf(fixture({ server: 'redis_url: "http://u:SECRETPW@h"\n' }));
    expect(JSON.stringify(fromYaml)).not.toContain('SECRETPW');
  });
  it('junk files give a ConfigError, never another crash', () => {
    const dirs = [
      fixture({ models: '\u0000\u0001ÿ' }),
      fixture({ models: '- a\n- b\n' }),
      fixture({ models: '1: 2\n' }),
      fixture({ server: 'port:\t1\n' }),
      fixture({ server: `x: ${'0'.repeat(5 << 20)}\n` }),
      (() => {
        const d = fixture();
        rmSync(join(d, 'models.yaml'));
        mkdirSync(join(d, 'models.yaml'));
        return d;
      })(),
    ];
    for (const dir of dirs) expect(() => load(dir)).toThrow(ConfigError);
  });
  it('a second YAML document is a ConfigError, even when it holds a bad key', () => {
    const issues = issuesOf(fixture({ server: 'port: 1\n---\nport: 2\nbogus: 3' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'config/server.yaml', path: '(file)' });
    expect(issues[0]?.message).toMatch(/multiple documents/);
  });
  it('a custom tag is a ConfigError on that file and prints nothing to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write');
    const warn = vi.spyOn(console, 'warn');
    const issues = issuesOf(fixture({ server: 'port: !foo 1\n' }));
    expect(issues[0]).toMatchObject({ file: 'config/server.yaml', path: '(file)' });
    expect(issues[0]?.message).toMatch(/tag/i);
    expect(write).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('a __proto__ key is an Unrecognized key at the top level, in strict sections and in loose ones', () => {
    const paths = (server: string) => issuesOf(fixture({ server })).map((i) => [i.file, i.path, i.message]);
    const bad = (path: string) => [['config/server.yaml', path, 'Unrecognized key']];
    expect(paths('__proto__: {polluted: 1}\n')).toEqual(bad('__proto__'));
    expect(paths('graph:\n  __proto__: 1\n')).toEqual(bad('graph.__proto__'));
    expect(paths('cache:\n  __proto__: {polluted: 1}\n')).toEqual(bad('cache.__proto__'));
    expect(paths('cache:\n  ttl:\n    __proto__: 1\n')).toEqual(bad('cache.ttl.__proto__'));
    expect(paths('runner:\n  agents:\n    __proto__: {argv: [x]}\n')).toEqual(bad('runner.agents.__proto__'));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('a tab after a colon is a ConfigError on that file', () => {
    expect(issuesOf(fixture({ server: 'port:\t1\n' })).map((i) => [i.file, i.path])).toEqual([['config/server.yaml', '(file)']]);
  });
  it('a tab inside a comment or a quoted scalar is valid YAML', () => {
    expect(load(fixture({ server: 'runner:\n  max_failures: 3 # see:\tnote\n' })).runner.max_failures).toBe(3);
    expect(load(fixture({ server: 'runner:\n  worktree:\n    dir: "a-\tb"\n' })).runner.worktree.dir).toBe('a-\tb');
  });
  it('a config file over the size cap is a ConfigError, not a parser out-of-memory abort', () => {
    const issues = issuesOf(fixture({ server: `runner:\n  x: ${'['.repeat(300_000)}\n` }));
    expect(issues[0]).toMatchObject({ file: 'config/server.yaml', path: '(file)' });
  });
  it('configuring one agent keeps the built-in ones', () => {
    const c = load(fixture({ server: 'runner:\n  agents:\n    claude:\n      argv: [claude, -p]\n' }));
    expect(c.runner.agents['claude']?.argv).toEqual(['claude', '-p']);
    expect(c.runner.agents['codex']?.argv).toEqual(['codex', 'exec', '--json']);
  });
  it('does not modify the env argument and returns the same result for the same input', () => {
    const env = { CTC_PORT: '19999', CTC_DATABASE_URL: 'postgresql://u:p@h:5432/d' };
    const copy = { ...env };
    const dir = fixture();
    expect(load(dir, env)).toEqual(load(dir, env));
    expect(env).toEqual(copy);
  });
  it('reads neither .env nor the process environment when env is given', () => {
    vi.stubEnv('CTC_PORT', '1234');
    try {
      expect(load(fixture(), {}).port).toBe(18310);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('loadConfigOrExit (D3c)', () => {
  it('prints each issue line to stderr and exits 78', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      expect(() => loadConfigOrExit({ dir: fixture({ server: 'port: 0\n' }), env: {}, home: HOME })).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(78);
      expect(write.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^config\/server\.yaml: port: .+\n$/)]);
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  });
  it('returns the config when valid', () => {
    expect(loadConfigOrExit({ dir: fixture(), env: {}, home: HOME }).port).toBe(18310);
  });
});
