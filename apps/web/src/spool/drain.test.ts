import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConflictError, RepoError } from '@ctc/shared/repositories';
import { createSpoolDrain, nudgeRoute, spoolLimits, type DrainReport, type SpoolDeps } from './index.ts';

const dirs: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t41-unit-'));
  dirs.push(d);
  return d;
};
const keepLimits = { ...spoolLimits };
afterEach(() => {
  Object.assign(spoolLimits, keepLimits);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ZERO: DrainReport = { queued: 0, dropped: 0, corrupt: 0, kept: 0, expired: 0 };
const rep = (o: Partial<DrainReport>): DrainReport => ({ ...ZERO, ...o });
const DAY = 86_400_000;
const CWD = '/proj/app';
const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const env = (event: string, payload: unknown, extra: object = {}) => ({ v: 1, event, received_at: iso(), payload, ...extra });
const hook = (event: string, sid: string, extra: object = {}) => ({ session_id: sid, transcript_path: `/t/${sid}.jsonl`, cwd: CWD, hook_event_name: event, ...extra });
const edit = (sid: string, file = `${CWD}/src/a.ts`, tool = 'Edit') => hook('PostToolUse', sid, { tool_name: tool, tool_input: { file_path: file } });
let seq = 0;
const put = (dir: string, name: string, body: unknown, mtimeMs?: number) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  if (mtimeMs !== undefined) fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
};
const nm = (event: string) => `s${++seq}-${event}-1-${String(seq).padStart(8, '0')}.json`;
const listJson = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

type Rec = { jobs: { id: string; queue: string; kind: string; payload: Record<string, unknown> }[]; added: string[]; sessions: unknown[]; roots: string[]; logs: [string, unknown][] };
/** Fake queues and repositories: records what the drain asks for. `redisDown` makes every add fail. */
function fakes(o: { redisDown?: boolean; sessionError?: unknown; projectError?: unknown } = {}) {
  const rec: Rec = { jobs: [], added: [], sessions: [], roots: [], logs: [] };
  const queues = {
    names: ['graph', 'llm'],
    get: () => ({ add: async (_k: string, data: { id: string }) => (o.redisDown ? Promise.reject(new Error('down')) : rec.added.push(data.id)) }),
    close: async () => undefined,
  };
  const repos = {
    projects: { upsert: async (_c: unknown, i: { root: string }) => { if (o.projectError) throw o.projectError; rec.roots.push(i.root); return { id: `p${rec.roots.length}` }; } },
    sessions: { upsert: async (_c: unknown, i: unknown) => { if (o.sessionError) throw o.sessionError; rec.sessions.push(i); return {}; } },
    jobs: {
      create: async (_c: unknown, i: Rec['jobs'][number]) => {
        const old = rec.jobs.find((j) => j.id === i.id);
        if (!old) rec.jobs.push(i);
        return { job: { id: i.id }, created: !old };
      },
    },
  };
  return { rec, queues: queues as unknown as SpoolDeps['queues'], repos: repos as SpoolDeps['repos'], log: (m: string, f?: unknown) => rec.logs.push([m, f]) };
}
const drain = (dir: string, o: Partial<SpoolDeps> & { f?: ReturnType<typeof fakes> } = {}) => {
  const { f = fakes(), ...rest } = o;
  const d = createSpoolDrain({ dir, keepDays: 7, queues: f.queues, repos: f.repos, log: f.log, ...rest });
  return { d, f };
};

describe('D2 limits', () => {
  it('pins the defaults', () => {
    expect({ ...spoolLimits }).toEqual({ maxFileBytes: 1_048_576, sweepEveryMs: 30_000, nudgeTimeoutMs: 250 });
  });
  it('a file of exactly maxFileBytes is read, one byte more goes to corrupt/ unread', async () => {
    const dir = mk();
    const body = JSON.stringify(env('Stop', hook('Stop', 'sz')));
    spoolLimits.maxFileBytes = Buffer.byteLength(body) + 10;
    put(dir, 'eq-Stop-1-00000001.json', body.slice(0, -1) + ' '.repeat(10) + '}');
    put(dir, 'gt-Stop-1-00000002.json', body.slice(0, -1) + ' '.repeat(11) + '}');
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 1, corrupt: 1 }));
    expect(fs.readdirSync(path.join(dir, 'corrupt'))).toEqual(['gt-Stop-1-00000002.json']);
    expect(f.rec.logs.some(([, x]) => (x as { reason?: string }).reason === 'too_big')).toBe(true);
  });
  it('keepDays counts from mtime: exactly 7 days old is kept, older is expired (undeliverable files only)', async () => {
    const dir = mk();
    const now = Math.floor(Date.now() / 1000) * 1000;
    put(dir, 'k7-Stop-1-0000000a.json', env('Stop', hook('Stop', 'k7')), now - 7 * DAY);
    put(dir, 'k8-Stop-1-0000000b.json', env('Stop', hook('Stop', 'k8')), now - 7 * DAY - 1000);
    const { d } = drain(dir, { f: fakes({ redisDown: true }), now: () => now });
    expect(await d.drainOnce()).toEqual(rep({ kept: 1, expired: 1 }));
    expect(listJson(dir)).toEqual(['k7-Stop-1-0000000a.json']);
  });
  it('a deliverable file is delivered whatever its age', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'old')), Date.now() - 30 * DAY);
    expect(await drain(dir).d.drainOnce()).toEqual(rep({ queued: 1 }));
  });
});

describe('D3 job ids and payloads', () => {
  it('one job per file, id spool:<basename>, payloads omit unknown keys', async () => {
    const dir = mk();
    const e = nm('PostToolUse');
    const s = nm('Stop');
    const x = nm('SessionEnd');
    put(dir, e, env('PostToolUse', edit('a')), Date.now() - 3000);
    put(dir, s, env('Stop', { session_id: 'b' }), Date.now() - 2000);
    put(dir, x, env('SessionEnd', hook('SessionEnd', 'c', { transcript_path: 7 })), Date.now() - 1000);
    const { d, f } = drain(dir, { userId: 'u-1' });
    expect(await d.drainOnce()).toEqual(rep({ queued: 3 }));
    expect(f.rec.jobs.map((j) => [j.id, `${j.queue}.${j.kind}`])).toEqual([
      [`spool:${e.slice(0, -5)}`, 'graph.rebuild'],
      [`spool:${s.slice(0, -5)}`, 'llm.extract'],
      [`spool:${x.slice(0, -5)}`, 'llm.summarize'],
    ]);
    expect(f.rec.jobs.map((j) => j.payload)).toEqual([
      { userId: 'u-1', projectId: 'p1', files: ['src/a.ts'] },
      { userId: 'u-1', sessionId: 'b' },
      { userId: 'u-1', projectId: 'p2', sessionId: 'c' },
    ]);
    expect(listJson(dir)).toEqual([]);
  });
  it('the report has exactly the five counters', async () => {
    expect(Object.keys(await drain(mk()).d.drainOnce()).sort()).toEqual(['corrupt', 'dropped', 'expired', 'kept', 'queued']);
  });
  it('the nudge route replies 204 with no body, before any file is read, and triggers a pass after start', async () => {
    const dir = mk();
    const { d, f } = drain(dir);
    await d.start();
    put(dir, 'zz-Stop-1-00000001.json.tmp', 'x');
    const route = nudgeRoute(d);
    const order: string[] = [];
    let code = 0;
    route.handler({ body: 'ignored' }, { code: (n) => ((code = n), { send: () => order.push('send') }) });
    expect([route.method, route.url, code, order]).toEqual(['POST', '/v1/spool/nudge', 204, ['send']]);
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'n1')));
    route.handler({}, { code: () => ({ send: () => undefined }) });
    await d.close();
    expect(f.rec.jobs.length + listJson(dir).length).toBe(1);
  });
});

describe('D4 bad input', () => {
  it('classifies each bad file as corrupt once and never retries it', async () => {
    const dir = mk();
    put(dir, 'a-Stop-1-00000001.json', 'not json');
    put(dir, 'b-Stop-1-00000002.json', { ...env('Stop', hook('Stop', 'b')), v: 2 });
    put(dir, 'c-Stop-1-00000003.json', env('Stop', [1]));
    put(dir, 'd-Stop-1-00000004.json', env('Stop', { cwd: CWD }));
    put(dir, 'e-PostToolUse-1-00000005.json', env('PostToolUse', { ...edit('e'), tool_input: { old_string: 'x' } }));
    put(dir, 'f-Stop-1-00000006.json', Buffer.from([0xff, 0xfe, 0x7b]) as unknown as string);
    put(dir, 'g-Stop-1-00000007.json', { ...env('Stop', { ...hook('Stop', 'g'), transcript_path: 42 }), extra: true });
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 1, corrupt: 6 }));
    expect(fs.readdirSync(path.join(dir, 'corrupt')).length).toBe(6);
    expect(f.rec.jobs[0]?.payload).toEqual({ userId: 'local', projectId: 'p1', sessionId: 'g' });
    expect(await d.drainOnce()).toEqual(ZERO);
  });
  it('a NUL or lone surrogate in a string field is corrupt (required) and never blocks newer files', async () => {
    const dir = mk();
    const bad = (sid: string) => `{"v":1,"event":"Stop","received_at":"2026-10-31T09:15:02Z","payload":{"session_id":"${sid}"}}`;
    put(dir, 'bad-Stop-1-00000001.json', bad('a\\u0000b'));
    put(dir, 'bad2-Stop-1-00000002.json', bad('\\ud800'));
    put(dir, 'good-Stop-1-00000003.json', env('Stop', hook('Stop', 'good')));
    const { d } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 1, corrupt: 2 }));
    expect(await d.drainOnce()).toEqual(ZERO);
  });
  it('an existing name in corrupt/ is never overwritten', async () => {
    const dir = mk();
    fs.mkdirSync(path.join(dir, 'corrupt'));
    put(path.join(dir, 'corrupt'), 'a-Stop-1-00000001.json', 'old');
    put(dir, 'a-Stop-1-00000001.json', 'not json');
    expect(await drain(dir).d.drainOnce()).toEqual(rep({ corrupt: 1 }));
    const names = fs.readdirSync(path.join(dir, 'corrupt')).sort();
    expect(names.length).toBe(2);
    expect(names[1]).toMatch(/^a-Stop-1-00000001\.json\.\d+$/);
    expect(fs.readFileSync(path.join(dir, 'corrupt', 'a-Stop-1-00000001.json'), 'utf8')).toBe('old');
  });
  it('bad deps throw TypeError synchronously', () => {
    const f = fakes();
    const base = { queues: f.queues, repos: f.repos };
    expect(() => createSpoolDrain({ ...base } as never)).toThrow(TypeError);
    expect(() => createSpoolDrain({ ...base, dir: '' } as never)).toThrow(TypeError);
    for (const keepDays of [0, -1, 1.5, Number.NaN, '7']) expect(() => createSpoolDrain({ ...base, dir: mk(), keepDays } as never)).toThrow(TypeError);
  });
});

describe('D5 odd but harmless input', () => {
  it('missing dir, empty dir, non-json names and young .tmp files give an empty report and stay untouched', async () => {
    const dir = mk();
    expect(await drain(path.join(dir, 'missing')).d.drainOnce()).toEqual(ZERO);
    expect(await drain(dir).d.drainOnce()).toEqual(ZERO);
    put(dir, 'notes.txt', 'keep');
    put(dir, 'y-Stop-1-00000001.json.tmp', '{"half":');
    put(dir, '.json', 'x');
    expect(await drain(dir).d.drainOnce()).toEqual(ZERO);
    expect(fs.readdirSync(dir).sort()).toEqual(['.json', 'notes.txt', 'y-Stop-1-00000001.json.tmp']);
  });
  it('relative file_path resolves against cwd, a trailing slash on cwd is removed, the same event twice makes two jobs', async () => {
    const dir = mk();
    put(dir, nm('PostToolUse'), env('PostToolUse', { ...edit('r', 'src/b.ts'), cwd: `${CWD}/` }), Date.now() - 2000);
    put(dir, nm('PostToolUse'), env('PostToolUse', { ...edit('r', 'src/b.ts'), cwd: `${CWD}/` }), Date.now() - 1000);
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 2 }));
    expect(f.rec.roots).toEqual([CWD, CWD]);
    expect(f.rec.jobs.map((j) => j.payload['files'])).toEqual([['src/b.ts'], ['src/b.ts']]);
  });
  it('a file deleted between readdir and read is skipped and counted nowhere', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'first')), Date.now() - 2000);
    const second = put(dir, nm('Stop'), env('Stop', hook('Stop', 'second')), Date.now() - 1000);
    const f = fakes();
    const create = f.repos.jobs.create;
    f.repos.jobs.create = async (c, i) => (fs.rmSync(second), create(c, i));
    expect(await drain(dir, { f }).d.drainOnce()).toEqual(rep({ queued: 1 }));
  });
});

describe('D6 drain must never', () => {
  it('skips symlinks, FIFOs and subdirectories and never logs payload text or paths', async () => {
    const dir = mk();
    expect(spawnSync('mkfifo', [path.join(dir, 'fifo-Stop-1-00000001.json')]).status).toBe(0);
    const outside = put(mk(), 'o.json', env('Stop', hook('Stop', 'o')));
    fs.symlinkSync(outside, path.join(dir, 'link-Stop-1-00000002.json'));
    fs.mkdirSync(path.join(dir, 'sub'));
    put(path.join(dir, 'sub'), 'n-Stop-1-00000003.json', env('Stop', hook('Stop', 'n')));
    put(dir, 'p-Stop-1-00000004.json', env('Stop', hook('Stop', 'p', { secret: 'SECRET-VALUE' })));
    put(dir, 'q-Stop-1-00000005.json', env('Stop', { cwd: '/leaky/path' }));
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 1, corrupt: 1 }));
    expect(fs.lstatSync(path.join(dir, 'link-Stop-1-00000002.json')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub', 'n-Stop-1-00000003.json'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    const logged = JSON.stringify(f.rec.logs);
    expect(logged.includes('SECRET-VALUE') || logged.includes('/leaky/path') || logged.includes(CWD)).toBe(false);
  });
  it('does not edit deps', async () => {
    const f = fakes();
    const deps = Object.freeze({ dir: mk(), keepDays: 7, queues: f.queues, repos: f.repos });
    put(deps.dir, nm('Stop'), env('Stop', hook('Stop', 'frozen')));
    expect(await createSpoolDrain(deps).drainOnce()).toEqual(rep({ queued: 1 }));
  });
});

describe('D7 non-goals', () => {
  it('makes one graph.rebuild per edit event (no debounce) and never prunes corrupt/', async () => {
    const dir = mk();
    put(dir, nm('PostToolUse'), env('PostToolUse', edit('g1')), Date.now() - 2000);
    put(dir, nm('PostToolUse'), env('PostToolUse', edit('g2')), Date.now() - 1000);
    fs.mkdirSync(path.join(dir, 'corrupt'));
    put(path.join(dir, 'corrupt'), 'old.json', 'x', Date.now() - 400 * DAY);
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 2 }));
    expect(f.rec.jobs.length).toBe(2);
    expect(fs.existsSync(path.join(dir, 'corrupt', 'old.json'))).toBe(true);
  });
});

describe('D8 silence rule', () => {
  it('an unreadable regular file is kept, not corrupt', async () => {
    const dir = mk();
    const file = put(dir, nm('Stop'), env('Stop', hook('Stop', 'ro')));
    fs.chmodSync(file, 0);
    const { d } = drain(dir);
    const r = await d.drainOnce();
    fs.chmodSync(file, 0o600);
    // root can read a mode-0 file; any other user must see `kept`
    expect(r).toEqual(process.getuid?.() === 0 ? rep({ queued: 1 }) : rep({ kept: 1 }));
  });
});

describe('D9 public names', () => {
  it('createSpoolDrain returns exactly start, drainOnce, nudge, close', () => {
    expect(Object.keys(drain(mk()).d).sort()).toEqual(['close', 'drainOnce', 'nudge', 'start']);
  });
});

describe('D12 routing', () => {
  it('drops Read, other events and edits outside the project; routes the rest', async () => {
    const dir = mk();
    const names = [
      ['PostToolUse', edit('r1', `${CWD}/a.ts`, 'Read')],
      ['SubagentStop', hook('SubagentStop', 'r2')],
      ['PostToolUse', edit('r3', '../../etc/passwd')],
      ['PostToolUse', edit('r4', '/etc/passwd')],
      ['PostToolUse', edit('r5', CWD)],
      ['PostToolUse', { ...edit('r6'), cwd: 'relative/cwd' }],
      ['PostToolUse', edit('r7', `${CWD}/..hidden`, 'Write')],
      ['PostToolUse', edit('r8', `${CWD}/x/../y.ts`, 'MultiEdit')],
    ] as const;
    names.forEach(([ev, p], i) => put(dir, nm(ev), env(ev, p), Date.now() - 10_000 + i));
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ dropped: 6, queued: 2 }));
    expect(f.rec.jobs.map((j) => j.payload['files'])).toEqual([['..hidden'], ['y.ts']]);
  });
  it('Stop without cwd has no projectId; relative cwd creates no project', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', { session_id: 'x', cwd: 'rel' }));
    const { d, f } = drain(dir);
    await d.drainOnce();
    expect(f.rec.roots).toEqual([]);
    expect(f.rec.jobs[0]?.payload).toEqual({ userId: 'local', sessionId: 'x' });
  });
  it('SessionEnd upserts the session (endedAt = received_at, transcriptPath) then queues the summary', async () => {
    const dir = mk();
    put(dir, nm('SessionEnd'), env('SessionEnd', hook('SessionEnd', 'se'), { received_at: '2026-01-02T03:04:05Z' }));
    const { d, f } = drain(dir);
    expect(await d.drainOnce()).toEqual(rep({ queued: 1 }));
    expect(f.rec.sessions).toEqual([{ id: 'se', projectId: 'p1', endedAt: '2026-01-02T03:04:05Z', transcriptPath: '/t/se.jsonl' }]);
    expect(f.rec.jobs.map((j) => j.kind)).toEqual(['summarize']);
  });
  it('a RepoError from the session upsert is logged and ignored; any other error keeps the file', async () => {
    const dir = mk();
    put(dir, nm('SessionEnd'), env('SessionEnd', hook('SessionEnd', 'se')));
    const refused = drain(dir, { f: fakes({ sessionError: new RepoError('conflict', 'x') }) });
    expect(await refused.d.drainOnce()).toEqual(rep({ queued: 1 }));
    put(dir, nm('SessionEnd'), env('SessionEnd', hook('SessionEnd', 'se2')));
    const broken = drain(dir, { f: fakes({ sessionError: new Error('db down') }) });
    expect(await broken.d.drainOnce()).toEqual(rep({ kept: 1 }));
    expect(listJson(dir).length).toBe(1);
  });
  it('an unusable root (over 2048 UTF-8 bytes, or refused with a RepoError) is not a project and blocks nothing', async () => {
    const dir = mk();
    const long = `/${'é'.repeat(1025)}`; // 2051 bytes, 1026 chars
    const ok = `/${'a'.repeat(2047)}`; // exactly 2048 bytes
    put(dir, nm('PostToolUse'), env('PostToolUse', { ...edit('l1', `${long}/a.ts`), cwd: long }), Date.now() - 30_000);
    put(dir, nm('Stop'), env('Stop', { ...hook('Stop', 'l2'), cwd: long }), Date.now() - 20_000);
    put(dir, nm('SessionEnd'), env('SessionEnd', { ...hook('SessionEnd', 'l3'), cwd: long }), Date.now() - 10_000);
    put(dir, nm('PostToolUse'), env('PostToolUse', { ...edit('l4', `${ok}/a.ts`), cwd: ok }));
    const a = drain(dir);
    expect(await a.d.drainOnce()).toEqual(rep({ dropped: 1, queued: 3 }));
    expect(a.f.rec.roots).toEqual([ok]);
    expect(a.f.rec.sessions).toEqual([]);
    expect(a.f.rec.jobs.map((j) => [j.kind, j.payload['projectId']])).toEqual([['extract', undefined], ['summarize', undefined], ['rebuild', 'p1']]);

    put(dir, nm('PostToolUse'), env('PostToolUse', edit('c1'), {}), Date.now() - 20_000);
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'c2')), Date.now() - 10_000);
    put(dir, nm('SessionEnd'), env('SessionEnd', hook('SessionEnd', 'c3')));
    const b = drain(dir, { f: fakes({ projectError: new ConflictError('id collision') }) });
    expect(await b.d.drainOnce()).toEqual(rep({ dropped: 1, queued: 2 }));
    expect(b.f.rec.sessions).toEqual([]);
    expect(b.f.rec.jobs.map((j) => [j.kind, j.payload['projectId']])).toEqual([['extract', undefined], ['summarize', undefined]]);

    put(dir, nm('Stop'), env('Stop', hook('Stop', 'c4')));
    const c = drain(dir, { f: fakes({ projectError: new Error('db down') }) });
    expect(await c.d.drainOnce()).toEqual(rep({ kept: 1 }));
  });
  it('userId comes from deps, never from the file', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', { ...hook('Stop', 'u'), userId: 'evil' }, { userId: 'evil' }));
    const { d, f } = drain(dir, { userId: 'owner' });
    await d.drainOnce();
    expect(f.rec.jobs[0]?.payload['userId']).toBe('owner');
  });
});

describe('D13 delivery', () => {
  it('Redis down keeps every file and stops delivering after the first failure; Redis up delivers once', async () => {
    const dir = mk();
    [1, 2, 3].forEach((i) => put(dir, `q${i}-Stop-1-0000000${i}.json`, env('Stop', hook('Stop', `q${i}`)), Date.now() - (10 - i) * 1000));
    const down = fakes({ redisDown: true });
    expect(await drain(dir, { f: down }).d.drainOnce()).toEqual(rep({ kept: 3 }));
    expect(down.rec.jobs.length).toBe(1);
    const up = fakes();
    up.rec.jobs.push(...down.rec.jobs);
    expect(await drain(dir, { f: up }).d.drainOnce()).toEqual(rep({ queued: 3 }));
    expect(up.rec.jobs.length).toBe(3);
    put(dir, 'q1-Stop-1-00000001.json', env('Stop', hook('Stop', 'q1')));
    expect(await drain(dir, { f: up }).d.drainOnce()).toEqual(rep({ queued: 1 }));
    expect(up.rec.jobs.length).toBe(3);
  });
  it('a store that throws keeps the file and the pass does not reject', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'x')));
    const f = fakes();
    f.repos.jobs.create = () => Promise.reject(new Error('pg down'));
    expect(await drain(dir, { f }).d.drainOnce()).toEqual(rep({ kept: 1 }));
  });
  it('a .tmp file is deleted only when older than keepDays', async () => {
    const dir = mk();
    put(dir, 'old-Stop-1-00000009.json.tmp', '{', Date.now() - 8 * DAY);
    put(dir, 'new-Stop-1-0000000a.json.tmp', '{', Date.now() - 6 * DAY);
    expect(await drain(dir).d.drainOnce()).toEqual(rep({ expired: 1 }));
    expect(fs.readdirSync(dir)).toEqual(['new-Stop-1-0000000a.json.tmp']);
  });
});

describe('D14 triggers and concurrency', () => {
  it('start creates dir and corrupt/ with mode 0700, runs a boot pass, and is idempotent', async () => {
    const dir = path.join(mk(), 'spool');
    const { d } = drain(dir);
    await d.start();
    await d.start();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'corrupt')).isDirectory()).toBe(true);
    await d.close();
  });
  it('the boot pass delivers files already there; the watcher delivers new ones', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'boot')));
    const { d, f } = drain(dir);
    await d.start();
    expect(f.rec.jobs.length).toBe(1);
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'watched')));
    const end = Date.now() + 3000;
    while (f.rec.jobs.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(f.rec.jobs.length).toBe(2);
    await d.close();
  });
  it('the sweep interval delivers a file the watcher missed', async () => {
    const dir = mk();
    spoolLimits.sweepEveryMs = 50;
    const { d, f } = drain(dir);
    await d.start();
    put(dir, 'later-Stop-1-00000001.json.tmp', '{'); // watcher noise only
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'swept')));
    const end = Date.now() + 3000;
    while (f.rec.jobs.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(f.rec.jobs.length).toBe(1);
    await d.close();
  });
  it('nudge before start and after close is ignored and never throws', async () => {
    const dir = mk();
    const { d, f } = drain(dir);
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'ign')));
    d.nudge();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.rec.jobs.length).toBe(0);
    await d.start();
    await d.close();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'ign2')));
    d.nudge();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.rec.jobs.length).toBe(1);
  });
  it('overlapping triggers never run two passes at once and coalesce into one follow-up pass', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'c1')));
    const f = fakes();
    let live = 0;
    let peak = 0;
    let passes = 0;
    const create = f.repos.jobs.create;
    f.repos.jobs.create = async (c, i) => {
      live++;
      peak = Math.max(peak, live);
      passes++;
      await new Promise((r) => setTimeout(r, 30));
      live--;
      return create(c, i);
    };
    const { d } = drain(dir, { f });
    const reports = await Promise.all([d.drainOnce(), d.drainOnce(), d.drainOnce(), d.drainOnce()]);
    expect(peak).toBe(1);
    expect(passes).toBe(1);
    expect(reports.map((r) => r.queued)).toEqual([1, 0, 0, 0]);
  });
  it('close waits for a running pass and is idempotent', async () => {
    const dir = mk();
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'cl')));
    const f = fakes();
    const create = f.repos.jobs.create;
    f.repos.jobs.create = async (c, i) => (await new Promise((r) => setTimeout(r, 50)), create(c, i));
    const { d } = drain(dir, { f });
    await d.start().catch(() => undefined);
    put(dir, nm('Stop'), env('Stop', hook('Stop', 'cl2')));
    const running = d.drainOnce();
    await Promise.all([d.close(), d.close()]);
    expect((await running).queued).toBe(1);
  });
});
