import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '../cache/keys.ts';
import { createTei, TeiError, teiLimits } from './index.ts';

const DIM = 8;
const vec = (i: number): number[] => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));
type Body = { inputs: string[]; texts: string[]; query: string };
type Req = { op: string; url: string; method: string; ct: string | undefined; body: Body };
type Mode = 'ok' | 'hang' | 'fail' | 'short' | 'baddim' | 'nan' | 'missing' | 'dup' | 'json';

const reqs: Req[] = [];
let mode: Mode = 'ok';
let delayMs = 0;
let server: http.Server;
let port = 0;
let deadPort = 0;
const socks = new Set<import('node:net').Socket>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reset = (): void => { reqs.length = 0; mode = 'ok'; delayMs = 0; };
const mk = (o: Record<string, unknown> = {}) =>
  createTei({
    config: { embed_url: `http://127.0.0.1:${port}`, rerank_url: `http://127.0.0.1:${port}`, embed_model: 'm-test', embedding_dim: DIM, timeout_s: 2, batch_timeout_s: 5, ...o },
    ...(o['cache'] ? { cache: o['cache'] as never } : {}),
    ...(o['log'] ? { log: o['log'] as never } : {}),
  });
const err = async (p: Promise<unknown>): Promise<{ name: string; code: string; status?: number; message: string } | null> => { try { await p; return null; } catch (e) { return e as { name: string; code: string; status?: number; message: string }; } };

beforeAll(async () => {
  server = http.createServer((rq, res) => {
    let raw = '';
    rq.on('data', (c) => (raw += c));
    rq.on('end', async () => {
      let body = {} as Body;
      try { body = JSON.parse(raw) as Body; } catch { /* keep empty */ }
      const op = rq.url?.endsWith('/embed') ? 'embed' : rq.url?.endsWith('/rerank') ? 'rerank' : 'other';
      reqs.push({ op, url: rq.url ?? '', method: rq.method ?? '', ct: rq.headers['content-type'], body });
      const send = (code: number, obj: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (mode === 'hang') return;
      if (delayMs) await sleep(delayMs);
      if (mode === 'fail') return send(503, { error: 'down' });
      if (mode === 'json') { res.writeHead(200); return void res.end('not json'); }
      if (op === 'embed') {
        let out = body.inputs.map((t) => vec(Number(t.match(/\d+$/)?.[0] ?? 0) % DIM));
        if (mode === 'short') out = out.slice(1);
        if (mode === 'baddim') out = out.map((v) => v.slice(1));
        if (mode === 'nan') out = out.map((v) => [null as never, ...v.slice(1)]);
        return send(200, out);
      }
      if (op === 'rerank') {
        let out = body.texts.map((t, i) => ({ index: i, score: Number(t.match(/-?\d+$/)?.[0] ?? 0) })).sort((a, b) => b.score - a.score);
        if (mode === 'missing') out = out.slice(1);
        if (mode === 'dup') out = out.map((r) => ({ ...r, index: 0 }));
        return send(200, out);
      }
      return send(404, {});
    });
  });
  server.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
});
afterAll(async () => {
  for (const s of socks) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('tei limits (D2)', () => {
  it('pins the batch size; 32 inputs are one request, 33 are two', async () => {
    expect({ ...teiLimits }).toEqual({ batch: 32 });
    reset();
    const out = await mk().embed(Array.from({ length: 32 }, (_, i) => `t ${i}`));
    expect([out.length, reqs.map((r) => r.body.inputs.length)]).toEqual([32, [32]]);
    reset();
    const out33 = await mk().embed(Array.from({ length: 33 }, (_, i) => `t ${i}`));
    expect([out33.length, reqs.map((r) => r.body.inputs.length)]).toEqual([33, [32, 1]]);
  });
});

describe('embed (D11)', () => {
  it('sends POST <url>/embed with inputs and truncate, strips a trailing slash, returns vectors in input order', async () => {
    reset();
    const t = createTei({ config: { embed_url: `http://127.0.0.1:${port}/`, rerank_url: '', embed_model: 'm', embedding_dim: DIM, timeout_s: 2, batch_timeout_s: 5 } });
    const out = await t.embed(['a 3', 'b 5']);
    expect(out).toEqual([vec(3), vec(5)]);
    expect(reqs.map((r) => [r.url, r.method, r.ct?.split(';')[0], r.body])).toEqual([['/embed', 'POST', 'application/json', { inputs: ['a 3', 'b 5'], truncate: true }]]);
  });
  it('rejects bad replies, http errors and unreachable servers with TeiError codes and plain messages', async () => {
    const codes: unknown[] = [];
    for (const m of ['short', 'baddim', 'nan', 'fail', 'json'] as const) { reset(); mode = m; const e = await err(mk().embed(['x', 'y'])); codes.push([e?.name, e?.code, e?.status, e instanceof TeiError]); }
    reset();
    const dead = await err(mk({ embed_url: `http://127.0.0.1:${deadPort}` }).embed(['SECRET-TEXT']));
    expect(codes).toEqual([
      ['TeiError', 'bad_reply', undefined, true], ['TeiError', 'bad_reply', undefined, true], ['TeiError', 'bad_reply', undefined, true],
      ['TeiError', 'http', 503, true], ['TeiError', 'bad_reply', undefined, true],
    ]);
    expect([dead?.code, dead?.message]).toEqual(['unreachable', 'tei embed unreachable']);
    mode = 'fail';
    expect((await err(mk().embed(['x'])))?.message).toBe('tei embed http 503');
  });
  it('times out per request (1 input: timeout_s, more: batch_timeout_s), honours the caller signal', async () => {
    reset(); mode = 'hang';
    const t0 = Date.now();
    const te = await err(mk({ timeout_s: 0.3, batch_timeout_s: 0.3 }).embed(['x']));
    expect([te?.code, Date.now() - t0 < 2500]).toEqual(['timeout', true]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect((await err(mk({ timeout_s: 5 }).embed(['x'], { signal: ac.signal })))?.code).toBe('aborted');
    reset(); delayMs = 600;
    expect((await err(mk({ timeout_s: 0.3, batch_timeout_s: 5 }).embed(['x'])))?.code).toBe('timeout');
    expect((await mk({ timeout_s: 0.3, batch_timeout_s: 5 }).embed(['x', 'y'])).length).toBe(2);
  });
  it('an already aborted signal sends no request; empty input sends none either', async () => {
    reset();
    const ac = new AbortController();
    ac.abort();
    expect((await err(mk().embed(['x'], { signal: ac.signal })))?.code).toBe('aborted');
    expect(await mk().embed([])).toEqual([]);
    expect(await mk().rerank('q', [])).toEqual([]);
    expect(reqs).toHaveLength(0);
  });
  it('caches under emb:<sha1(model NUL text)> for 7 days, sends only misses, once per duplicate; a short cached vector is a miss', async () => {
    reset();
    const m = new Map<string, Float32Array>();
    const sets: [string, number][] = [];
    const cache = { async getVec(k: string) { return m.get(k); }, async setVec(k: string, v: ArrayLike<number>, s: number) { sets.push([k, s]); m.set(k, Float32Array.from(v)); } };
    const t = mk({ cache });
    await t.embed(['c 7', 'c 7']);
    expect(reqs.map((r) => r.body.inputs)).toEqual([['c 7']]);
    expect(sets).toEqual([[keys.emb('m-test\u0000c 7'), 604800]]);
    const again = await t.embed(['c 7']);
    expect([reqs.length, again[0]![7]]).toEqual([1, 1]);
    m.set(keys.emb('m-test\u0000short 1'), Float32Array.from([1, 2]));
    await t.embed(['short 1']);
    expect(reqs).toHaveLength(2);
  });
  it('a throwing cache never fails the call', async () => {
    reset();
    const logs: unknown[] = [];
    const boom = { async getVec(): Promise<never> { throw new Error('redis down SECRET'); }, async setVec(): Promise<never> { throw new Error('redis down'); } };
    const out = await mk({ cache: boom, log: (m: string, f: unknown) => logs.push([m, f]) }).embed(['d 5']);
    expect(out).toEqual([vec(5)]);
    expect(JSON.stringify(logs)).not.toContain('SECRET');
  });
});

describe('rerank (D12)', () => {
  it('sends the query and texts with raw_scores and truncate and returns logits in input order', async () => {
    reset();
    const out = await mk().rerank('the query', ['r -1', 'r 3', 'r 1']);
    expect(out).toEqual([-1, 3, 1]);
    expect(reqs.map((r) => [r.url, r.body])).toEqual([['/rerank', { query: 'the query', texts: ['r -1', 'r 3', 'r 1'], raw_scores: true, truncate: true }]]);
  });
  it('a missing, duplicate or failing reply is an error; 33 texts are 2 requests', async () => {
    for (const m of ['missing', 'dup', 'fail'] as const) { reset(); mode = m; expect((await err(mk().rerank('q', ['r 1', 'r 2'])))?.code).toBe(m === 'fail' ? 'http' : 'bad_reply'); }
    reset();
    const many = await mk().rerank('q', Array.from({ length: 33 }, (_, i) => `t ${i}`));
    expect([many.length, reqs.map((r) => r.body.texts.length)]).toEqual([33, [32, 1]]);
  });
});
