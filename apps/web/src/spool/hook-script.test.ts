import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SpoolFileSchema } from '@ctc/shared/spool';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../../hooks/spool');
const FIX = path.join(HERE, 'fixtures');
const fixture = (n: string) => fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8');

const tmps: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t41-sh-'));
  tmps.push(d);
  return d;
};
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

type Run = { code: number | null; stdout: string; stderr: string; ms: number };
/** Runs hooks/spool under dash with a clean env; nudges go to a closed loopback port unless `nudge` is given. */
function run(o: { stdin: string; args?: string[]; dir: string; nudge: string; env?: Record<string, string>; shell?: string }): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const shell = o.shell ?? 'dash';
    const p = spawn(shell, [SCRIPT, ...(o.args ?? [])], {
      env: { PATH: process.env['PATH'] ?? '', HOME: mk(), CTC_SPOOL_DIR: o.dir, CTC_NUDGE_URL: o.nudge, ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.stderr.on('data', (b) => (stderr += b));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.on('error', () => undefined);
    p.stdin.end(o.stdin);
  });
}
let closed: string | undefined;
const closedUrl = async () => (closed ??= `http://127.0.0.1:${await freePort()}/v1/spool/nudge`);
const files = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const body = (dir: string, f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { v: number; event: string; received_at: string; payload: unknown };

describe('hooks/spool', () => {
  it('D10 is a POSIX sh script: executable, #!/bin/sh, parses under sh and dash', () => {
    fs.accessSync(SCRIPT, fs.constants.X_OK);
    expect(fs.readFileSync(SCRIPT, 'utf8').split('\n')[0]).toBe('#!/bin/sh');
    for (const sh of ['sh', 'dash']) expect(spawnSync(sh, ['-n', SCRIPT]).status).toBe(0);
  });

  it('D3 writes one atomic file named <session>-<event>-<epoch_ns>-<rand>.json with the exact body shape', async () => {
    const dir = path.join(mk(), 'new-spool');
    const stdin = fixture('post-edit');
    const r = await run({ stdin, args: ['PostToolUse'], dir, nudge: await closedUrl() });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    const [f] = files(dir);
    expect(f).toMatch(/^7f3c2d1e-9a4b-4c55-8e0a-1b2c3d4e5f60-PostToolUse-\d{1,20}-[0-9a-f]{8}\.json$/);
    const b = body(dir, f!);
    expect(Object.keys(b)).toEqual(['v', 'event', 'received_at', 'payload']);
    expect([b.v, b.event]).toEqual([1, 'PostToolUse']);
    expect(b.received_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(b.payload).toEqual(JSON.parse(stdin));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(SpoolFileSchema.safeParse(b).success).toBe(true);
  });

  it('D1 a hostile session_id becomes a safe basename inside the spool dir', async () => {
    const dir = mk();
    await run({ stdin: JSON.stringify({ session_id: '../../x y/..', hook_event_name: 'Stop' }), args: ['Stop'], dir, nudge: await closedUrl() });
    const names = fs.readdirSync(dir);
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]{1,64}-Stop-\d{1,20}-[0-9a-f]{8}\.json$/);
    const long = await run({ stdin: JSON.stringify({ session_id: 's'.repeat(200) }), args: ['Stop'], dir, nudge: await closedUrl() });
    expect(long.code).toBe(0);
    expect(files(dir).some((f) => f.startsWith(`${'s'.repeat(64)}-Stop-`))).toBe(true);
  });

  it('D3 a session_id with newlines is cut to 64 chars in total, not per line', async () => {
    const dir = mk();
    const l = 'a'.repeat(60);
    await run({ stdin: `{"session_id":"${l}\n${l}\n${l}\n${l}\n${l}"}`, args: ['Stop'], dir, nudge: await closedUrl() });
    const names = files(dir);
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]{1,64}-Stop-\d{1,20}-[0-9a-f]{8}\.json$/);
  });
  it('D5 empty or whitespace-only stdin writes no file; no session_id gives nosession', async () => {
    const dir = mk();
    for (const stdin of ['', '  \n\t ']) expect((await run({ stdin, args: ['Stop'], dir, nudge: await closedUrl() })).code).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    await run({ stdin: '{"hook_event_name":"Stop","cwd":"/x"}', dir, nudge: await closedUrl() });
    expect(files(dir)[0]).toMatch(/^nosession-Stop-/);
  });

  it('D5 stdin without a trailing newline and non-JSON stdin are both spooled as they are', async () => {
    const dir = mk();
    await run({ stdin: 'plain text', args: ['Stop'], dir, nudge: await closedUrl() });
    expect(fs.readFileSync(path.join(dir, files(dir)[0]!), 'utf8')).toContain('"payload":plain text}');
  });

  it('D6 exits 0 and prints nothing when the spool dir cannot be created', async () => {
    const r = await run({ stdin: fixture('stop'), args: ['Stop'], dir: '/proc/ctc-t41-no/such/dir', nudge: await closedUrl() });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
  });

  it('D6 returns within 500 ms for a 10 KB payload even when the nudge target accepts and never answers', async () => {
    let closedAt = 0;
    const hang = net.createServer((s) => {
      s.on('data', () => undefined);
      s.on('close', () => (closedAt = Date.now()));
      s.on('error', () => undefined);
    });
    await new Promise<void>((res) => hang.listen(0, '127.0.0.1', res));
    closers.push(() => hang.close());
    const t0 = Date.now();
    const dir = mk();
    const big = JSON.stringify({ session_id: 'h', hook_event_name: 'Stop', pad: 'x'.repeat(10_000) });
    const r = await run({ stdin: big, args: ['Stop'], dir, nudge: `http://127.0.0.1:${(hang.address() as net.AddressInfo).port}/v1/spool/nudge` });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(r.ms).toBeLessThanOrEqual(500);
    const end = Date.now() + 1500;
    while (!closedAt && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt - t0).toBeLessThanOrEqual(1500);
  });

  it('D3 the nudge is a POST with an empty body to CTC_NUDGE_URL', async () => {
    const got: string[] = [];
    const srv = net.createServer((s) => s.on('data', (d) => got.push(String(d))));
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    closers.push(() => srv.close());
    await run({ stdin: fixture('stop'), args: ['Stop'], dir: mk(), nudge: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/v1/spool/nudge` });
    const end = Date.now() + 1500;
    while (!got.length && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    expect(got[0]).toMatch(/^POST \/v1\/spool\/nudge HTTP\/1\.1\r\n/);
  });

  it('D10 the argv event wins, an invalid argv falls back to the payload, then to unknown', async () => {
    const dir = mk();
    const n = await closedUrl();
    await run({ stdin: JSON.stringify({ session_id: 'a1', hook_event_name: 'SessionEnd' }), args: ['Stop'], dir, nudge: n });
    await run({ stdin: JSON.stringify({ session_id: 'a2', hook_event_name: 'SessionEnd' }), args: ['bad name!'], dir, nudge: n });
    await run({ stdin: JSON.stringify({ session_id: 'a3' }), args: [], dir, nudge: n });
    await run({ stdin: JSON.stringify({ session_id: 'a4', tool_input: { hook_event_name: 'Nested' }, hook_event_name: 'Real' }), args: [], dir, nudge: n });
    await run({ stdin: JSON.stringify({ session_id: 'a5' }), args: ['E'.repeat(33)], dir, nudge: n });
    const ev = (sid: string) => files(dir).find((f) => f.startsWith(`${sid}-`))?.split('-')[1];
    expect(['a1', 'a2', 'a3', 'a5'].map(ev)).toEqual(['Stop', 'SessionEnd', 'unknown', 'unknown']);
    expect(ev('a4')).toBe('Nested'); // judgment: the first "hook_event_name" in text order wins, as D10 says
  });

  it('D10 still writes the file when curl and the other optional tools are missing', async () => {
    const bin = mk();
    for (const t of ['cat', 'awk', 'sed', 'tr', 'head', 'od', 'date', 'mkdir', 'mv', 'rm', 'dash']) {
      const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (w) fs.symlinkSync(w, path.join(bin, t));
    }
    const dir = mk();
    const r = await run({ stdin: fixture('stop'), args: ['Stop'], dir, nudge: await closedUrl(), env: { PATH: bin }, shell: path.join(bin, 'dash') });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(files(dir).length).toBe(1);
  });

  it('D11 strips <private>, <system-reminder> and <persisted-output> blocks, repeated, keeping a lone closing tag', async () => {
    const dir = mk();
    const text = 'keep1 <private>P1\\nP2</private> keep2 <system-reminder>R</system-reminder><persisted-output>O</persisted-output> </private> <private>P3</private>end';
    await run({ stdin: JSON.stringify({ session_id: 'st1', note: text }), args: ['Stop'], dir, nudge: await closedUrl() });
    expect((body(dir, files(dir)[0]!).payload as { note: string }).note).toBe('keep1  keep2  </private> end');
  });

  it('D11 a tag rebuilt by a removal is removed on the next round', async () => {
    const dir = mk();
    await run({ stdin: JSON.stringify({ session_id: 'st2', note: 'a<priv<private>x</private>ate>SECRET</private>b' }), args: ['Stop'], dir, nudge: await closedUrl() });
    expect(fs.readFileSync(path.join(dir, files(dir)[0]!), 'utf8')).not.toContain('SECRET');
  });

  it('D11 an unclosed opening tag removes the text to the end of its JSON string; the file stays valid JSON and the event survives', async () => {
    const dir = mk();
    const input = { session_id: 'st3', tool_name: 'Write', tool_input: { file_path: '/a/doc.md', content: 'explains the <private> tag SECRET-UNCLOSED \\" more' }, tool_response: 'ok' };
    await run({ stdin: JSON.stringify(input), args: ['PostToolUse'], dir, nudge: await closedUrl() });
    const text = fs.readFileSync(path.join(dir, files(dir)[0]!), 'utf8');
    expect(text).not.toContain('SECRET-UNCLOSED');
    const payload = body(dir, files(dir)[0]!).payload as { tool_input: { file_path: string; content: string }; tool_response: string };
    expect([payload.tool_input.file_path, payload.tool_input.content, payload.tool_response]).toEqual(['/a/doc.md', 'explains the ', 'ok']);
  });

  it('D11 an unclosed opening tag outside any string removes everything to the end', async () => {
    const dir = mk();
    await run({ stdin: '{"session_id":"st4"} <private>SECRET-TAIL', args: ['Stop'], dir, nudge: await closedUrl() });
    expect(fs.readFileSync(path.join(dir, files(dir)[0]!), 'utf8')).not.toContain('SECRET-TAIL');
  });

  it('D11 stripped text never reaches the event or session lookups', async () => {
    const dir = mk();
    await run({ stdin: '<private>{"session_id":"hidden","hook_event_name":"Hidden"}</private>{"session_id":"shown"}', dir, nudge: await closedUrl() });
    expect(files(dir)[0]).toMatch(/^shown-unknown-/);
  });

  it('D0 the four fixtures spool to files the schema accepts, and the committed spooled samples still match the script output', async () => {
    for (const [name, event] of [['post-edit', 'PostToolUse'], ['post-read', 'PostToolUse'], ['stop', 'Stop'], ['session-end', 'SessionEnd']] as const) {
      const dir = mk();
      await run({ stdin: fixture(name), args: [event], dir, nudge: await closedUrl() });
      const got = body(dir, files(dir)[0]!);
      const kept = JSON.parse(fs.readFileSync(path.join(FIX, 'spooled', `${name}.json`), 'utf8')) as typeof got;
      expect(SpoolFileSchema.safeParse(got).success).toBe(true);
      expect({ ...kept, received_at: '' }).toEqual({ ...got, received_at: '' });
    }
  });
});
