import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, createRepositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { deleteNamespace } from './redis-clean.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const PG = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const REDIS = 'redis://127.0.0.1:18395/0';
const WEB_PORT = 18410;
const WORKER_PORT = 18411;
const CTC_HOME = path.join(ROOT, '.ctc-dev');
const SPOOL = path.join(CTC_HOME, '.claudethecaller/spool');
const TOOLS = [
  'get_capability', 'graph_affected', 'graph_explain', 'graph_neighbors', 'graph_path', 'graph_search', 'load_capability_resource', 'mem_get', 'mem_search', 'mem_timeline',
  'run_workflow', 'save_memory', 'workflow_status',
];
const rnd = (): string => randomBytes(4).toString('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 20_000, every = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await sleep(every);
  }
}

const schema = `ctc_t71_${rnd()}`;
const namespace = `t71${rnd()}:`;
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-'));
const tmps = [emptyHome];
const mk = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
};
const procs = new Set<ChildProcess>();
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };

type Child = { p: ChildProcess; out: string; ready: Promise<Record<string, unknown>>; exit: Promise<{ code: number | null }> };
function launch(file: string, port: number): Child {
  const env = {
    PATH: process.env['PATH'] ?? '', HOME: emptyHome, CTC_HOME, CTC_PORT: String(port), CTC_DATABASE_URL: PG, CTC_REDIS_URL: REDIS, CTC_DB_SCHEMA: schema, CTC_REDIS_NAMESPACE: namespace,
  };
  const p = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const c: Child = { p, out: '', ready: undefined as never, exit: new Promise((res) => p.on('exit', (code) => res({ code }))) };
  p.stdout?.on('data', (d: Buffer) => (c.out += d));
  p.stderr?.on('data', (d: Buffer) => (c.out += d));
  c.ready = until(async () => {
    if (p.exitCode !== null) throw new Error(`${file} exited ${p.exitCode}: ${c.out.slice(-400)}`);
    const line = c.out.split('\n').find((l) => l.includes('"msg":"ready"'));
    return line ? (JSON.parse(line) as Record<string, unknown>) : null;
  }, 90_000, 50);
  return c;
}

function request(method: string, url: string, body?: unknown): Promise<{ status: number; text: string; json?: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers: Record<string, string> = data ? { 'content-type': 'application/json', 'content-length': String(data.length), accept: 'application/json, text/event-stream' } : {};
    const req = http.request({ host: '127.0.0.1', port: WEB_PORT, path: url, method, headers, timeout: 10_000 }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c));
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const rpc = async (method: string, params: unknown) => (await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params })).json;

function hook(command: string, stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('/bin/sh', ['-c', command], { env: { PATH: process.env['PATH'] ?? '', HOME: emptyHome, CTC_PORT: String(WEB_PORT), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d));
    p.stderr.on('data', (d: Buffer) => (stderr += d));
    p.stdin.on('error', () => undefined);
    p.stdin.end(stdin);
    p.on('exit', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}
const commandFor = (event: string): string => (settings.hooks[event]?.[0] as { hooks: { command: string }[] } | undefined)?.hooks[0]?.command as string;
const preCommand = (): string => (settings.hooks['PreToolUse'] as { hooks: { command: string }[] }[]).map((g) => g.hooks[0]?.command ?? '').find((c) => c.includes('/v1/hook/pre')) as string;
const ROUTE_HOOKS = [['prompt', commandFor('UserPromptSubmit'), 0.15], ['pre', preCommand(), 0.05], ['start', commandFor('SessionStart'), 1.5]] as const;

const portOpen = (port: number): Promise<boolean> => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => (s.destroy(), res(true))); s.once('error', () => res(false)); });

afterAll(async () => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  const db = createDb({ url: PG });
  await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  await db.close();
  await deleteNamespace(REDIS, namespace);
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

describe('switch.live', () => {
  it('runs hooks, spool, MCP and fail-open against a real dev instance on port 18410', async () => {
    await migrate({ url: PG, schema });
    const db = createDb({ url: PG, schema });
    const repos = createRepositories(db);
    const local = { userId: 'local' };
    try {
      const web = launch('apps/web/src/server/main.ts', WEB_PORT);
      const worker = launch('apps/worker/src/boot/main.ts', WORKER_PORT);
      const [webReady, workerReady] = await Promise.all([web.ready, worker.ready]);
      expect([webReady['app'], webReady['port'], workerReady['app']]).toEqual(['ctc-web', WEB_PORT, 'ctc-worker']);

      // 1. health
      const health = await request('GET', '/v1/health');
      expect([health.status, health.json?.db, health.json?.redis]).toEqual([200, 'up', 'up']);

      // 2. a throwaway repository and the three route hooks
      const repo = mk('ctc-t71-repo-');
      fs.mkdirSync(path.join(repo, 'src'));
      fs.mkdirSync(path.join(repo, 'specs/001-demo'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export function alpha() { return beta(); }\n');
      fs.writeFileSync(path.join(repo, 'src/b.ts'), 'export function beta() { return 1; }\n');
      fs.writeFileSync(path.join(repo, 'specs/001-demo/spec.md'), '# Demo\n\n## Tasks\n\n- T1 implement alpha in src/a.ts\n');
      const git = (...a: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const bodies = {
        prompt: { hook_event_name: 'UserPromptSubmit', session_id: 's-live', cwd: repo, prompt: 'where is alpha defined' },
        pre: { hook_event_name: 'PreToolUse', session_id: 's-live', cwd: repo, tool_name: 'Read', tool_input: { file_path: path.join(repo, 'src/a.ts') } },
        start: { hook_event_name: 'SessionStart', session_id: 's-live', cwd: repo, source: 'startup' },
      };
      const limits = { prompt: 400, pre: 5000, start: 10_000 };
      for (const [route, command, m] of ROUTE_HOOKS) {
        const r = await hook(command, JSON.stringify(bodies[route]));
        expect([route, r.code, r.stderr]).toEqual([route, 0, '']);
        expect(r.stdout.length).toBeLessThanOrEqual(limits[route]);
        expect(r.ms).toBeLessThan(m * 1000 + 3000);
        if (route === 'pre' && r.stdout !== '') expect(typeof JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('string');
      }

      // 3. the spool hook: a file, a job row, the file gone
      const edit = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's-live', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.ts') } });
      const spooled = await hook(commandFor('PostToolUse'), edit, { CLAUDE_PROJECT_DIR: ROOT, CTC_SPOOL_DIR: SPOOL, CTC_NUDGE_URL: `http://127.0.0.1:${WEB_PORT}/v1/spool/nudge` });
      expect([spooled.code, spooled.stdout, spooled.stderr]).toEqual([0, '', '']);
      const project = await until(async () => repos.projects.byRoot(local, repo), 15_000);
      await until(async () => (await repos.jobs.list(local, { queue: 'graph' })).rows.some((j) => (j.payload as { projectId?: string }).projectId === project.id), 15_000);
      await until(async () => (fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).every((f) => !f.endsWith('.json')) : true), 15_000);

      // 4. MCP over the same instance, with a built graph
      const build = await request('POST', '/api/graph/build', { project_id: project.id, force: true });
      expect(build.status).toBe(202);
      await until(async () => {
        const rows = (await repos.jobs.list(local, { queue: 'graph', status: 'done' })).rows;
        return rows.some((j) => (j.payload as { force?: boolean }).force === true);
      }, 60_000, 250);
      const list = await rpc('tools/list', {});
      expect((list.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(TOOLS);
      const search = await rpc('tools/call', { name: 'graph_search', arguments: { query: 'alpha', cwd: repo } });
      expect(search.result.isError).not.toBe(true);
      expect(search.result.content[0].text).toContain('alpha');

      // 5. API
      for (const url of ['/api/runs', '/api/capabilities']) {
        const r = await request('GET', url);
        expect([url, r.status, typeof r.json]).toEqual([url, 200, 'object']);
      }

      // 6. the web process dies: every route hook stays quiet and fast, then it comes back
      web.p.kill('SIGKILL');
      await web.exit;
      for (const [route, command, m] of ROUTE_HOOKS) {
        const r = await hook(command, JSON.stringify(bodies[route]));
        expect([route, r.code, r.stdout, r.stderr]).toEqual([route, 0, '', '']);
        expect(r.ms).toBeLessThanOrEqual(m * 1000 + 500);
      }
      const again = launch('apps/web/src/server/main.ts', WEB_PORT);
      await again.ready;
      expect((await request('GET', '/v1/health')).status).toBe(200);

      // 7. SIGTERM to both: exit 0 within 15 s, the port closed, nothing left
      const t0 = Date.now();
      again.p.kill('SIGTERM');
      worker.p.kill('SIGTERM');
      expect(await Promise.all([again.exit, worker.exit])).toEqual([{ code: 0 }, { code: 0 }]);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await portOpen(WEB_PORT)).toBe(false);
      expect([...procs].every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true);
      expect(fs.readdirSync(emptyHome)).toEqual([]);
    } finally {
      await db.close();
    }
  }, 240_000);
});
