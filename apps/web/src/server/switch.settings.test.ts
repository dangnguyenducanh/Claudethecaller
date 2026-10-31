import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
type Hook = { type: string; command: string; timeout: number };
type Group = { matcher?: string; hooks: Hook[] };
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, Group[]> };

const GRAPHIFY: Group[] = [
  { matcher: 'Bash|Grep', hooks: [{ type: 'command', command: 'graphify hook-guard search', timeout: 10 }] },
  { matcher: 'Read|Glob', hooks: [{ type: 'command', command: 'graphify hook-guard read', timeout: 10 }] },
];
const ROUTE_HOOKS = [
  ['UserPromptSubmit', 'prompt', '0.15', 1], ['PreToolUse', 'pre', '0.05', 1], ['SessionStart', 'start', '1.5', 3],
] as const;
const SPOOL_HOOKS = [['PostToolUse', 'Edit|Write|MultiEdit'], ['Stop', undefined], ['SessionEnd', undefined]] as const;

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-'));
  dirs.push(d);
  return d;
};
const HOME = tmp();
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const routeCommand = (route: string): string => {
  const hits = Object.values(settings.hooks).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes(`/v1/hook/${route}`));
  expect(hits).toHaveLength(1);
  return (hits[0] as Hook).command;
};

describe('switch.settings', () => {
  it('keeps the two graphify groups and adds exactly the six hook groups', () => {
    const g = settings.hooks;
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(Object.keys(g).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(g['PreToolUse']?.slice(0, 2)).toEqual(GRAPHIFY);
    expect(g['PreToolUse']).toHaveLength(3);
    for (const [event, groups] of Object.entries(g)) {
      const added = event === 'PreToolUse' ? groups.slice(2) : groups;
      expect([event, added.length, added[0]?.hooks.length]).toEqual([event, 1, 1]);
      const hook = added[0]?.hooks[0] as Hook;
      expect(Object.keys(hook).sort()).toEqual(['command', 'timeout', 'type']);
      expect(hook.type).toBe('command');
      expect(hook.command).not.toMatch(/ctc\.sock|--unix-socket|~/);
      expect(hook.command.replaceAll('${CTC_PORT:-18310}', '')).not.toContain('18310');
    }
    for (const [event, route, m, timeout] of ROUTE_HOOKS) {
      const group = (event === 'PreToolUse' ? g[event]?.slice(2) : g[event])?.[0] as Group;
      expect(group.hooks[0]?.timeout).toBe(timeout);
      expect(group.hooks[0]?.command).toBe(
        `LC_ALL=C curl -sf -m ${m} -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:\${CTC_PORT:-18310}/v1/hook/${route}" || true`,
      );
      expect(group.matcher).toBe(event === 'PreToolUse' ? 'Read|Edit|Write|MultiEdit|Grep|Glob|Bash' : undefined);
    }
    for (const [event, matcher] of SPOOL_HOOKS) {
      const group = g[event]?.[0] as Group;
      expect(group.matcher).toBe(matcher);
      expect(group.hooks[0]).toEqual({ type: 'command', command: `"$CLAUDE_PROJECT_DIR/hooks/spool" ${event} 2>/dev/null || true`, timeout: 2 });
    }
  });

  it('runs each hook command against a fake server and fails open', async () => {
    const run = (command: string, stdin: string, env: Record<string, string>) =>
      new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
        const t0 = Date.now();
        const p = spawn('/bin/sh', ['-c', command], { env: { PATH: process.env['PATH'] ?? '', HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d: Buffer) => (stdout += d));
        p.stderr.on('data', (d: Buffer) => (stderr += d));
        p.stdin.on('error', () => undefined);
        p.stdin.end(stdin);
        const kill = setTimeout(() => p.kill('SIGKILL'), 15_000);
        p.on('exit', (code) => (clearTimeout(kill), resolve({ code, stdout, stderr, ms: Date.now() - t0 })));
      });
    const fake = async (reply: { status: number; body?: string } | 'hang') => {
      const seen: { method: string | undefined; url: string | undefined; type: string | undefined; body: string }[] = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
          if (reply === 'hang') return;
          res.writeHead(reply.status, { 'content-type': 'text/plain' });
          res.end(reply.body ?? '');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return { port: (server.address() as net.AddressInfo).port, seen, close: () => (server.closeAllConnections(), server.close()) };
    };
    const stdin = '{"hook_event_name":"X","prompt":"h\\u00e9llo\\nworld","cwd":"/tmp/x"}\n';

    for (const [, route, m] of ROUTE_HOOKS) {
      const command = routeCommand(route);
      for (const [reply, want] of [[{ status: 200, body: `reply for ${route}` }, `reply for ${route}`], [{ status: 204 }, ''], [{ status: 500, body: '{"error":1}' }, ''], [{ status: 422, body: '{"error":2}' }, '']] as const) {
        const srv = await fake(reply);
        const r = await run(command, stdin, { CTC_PORT: String(srv.port) });
        srv.close();
        expect([route, reply.status, r.code, r.stdout, r.stderr]).toEqual([route, reply.status, 0, want, '']);
        expect(srv.seen).toEqual([{ method: 'POST', url: `/v1/hook/${route}`, type: 'application/json', body: stdin }]);
      }
      const hang = await fake('hang');
      const slow = await run(command, stdin, { CTC_PORT: String(hang.port) });
      hang.close();
      expect([slow.code, slow.stdout]).toEqual([0, '']);
      expect(slow.ms).toBeLessThanOrEqual(Number(m) * 1000 + 500);
      const closed = await new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
      const refused = await run(command, stdin, { CTC_PORT: String(closed) });
      expect([refused.code, refused.stdout, refused.stderr]).toEqual([0, '', '']);
    }

    for (const [event] of SPOOL_HOOKS) {
      const command = (settings.hooks[event]?.[0] as Group).hooks[0]?.command as string;
      const spool = tmp();
      const srv = await fake({ status: 204 });
      const payload = JSON.stringify({ hook_event_name: event, session_id: 's-settings', cwd: '/tmp/x', tool_name: 'Edit', tool_input: { file_path: '/tmp/x/a.ts' } });
      const ok = await run(command, payload, { CLAUDE_PROJECT_DIR: ROOT, CTC_SPOOL_DIR: spool, CTC_NUDGE_URL: `http://127.0.0.1:${srv.port}/v1/spool/nudge` });
      expect([event, ok.code, ok.stdout, ok.stderr]).toEqual([event, 0, '', '']);
      const written = fs.readdirSync(spool).filter((f) => f.endsWith('.json'));
      expect(written).toHaveLength(1);
      expect((JSON.parse(fs.readFileSync(path.join(spool, written[0] as string), 'utf8')) as { event: string }).event).toBe(event);
      srv.close();
      for (const dir of ['', '/nonexistent-ctc-t71']) {
        const none = tmp();
        const r = await run(command, payload, { CLAUDE_PROJECT_DIR: dir, CTC_SPOOL_DIR: none });
        expect([event, dir, r.code, r.stdout, r.stderr]).toEqual([event, dir, 0, '', '']);
        expect(fs.readdirSync(none)).toEqual([]);
      }
    }
  });
});
