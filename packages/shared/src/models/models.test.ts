import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createChat, createEmbedder, ModelError, modelLimits } from './index.ts';

type Req = { method: string | undefined; url: string | undefined; body: Record<string, unknown> | null };
const closers: (() => Promise<void>)[] = [];
afterAll(async () => void (await Promise.all(closers.map((c) => c()))));
const saved = { ...modelLimits };
afterEach(() => Object.assign(modelLimits, saved));

async function server(handle: (body: Record<string, unknown>, res: http.ServerResponse) => void) {
  const requests: Req[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      handle(parsed ?? {}, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, requests };
}
const send = (res: http.ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ModelError); return (e as ModelError).code; }
  return 'resolved';
};

describe('limits (D2)', () => {
  it('pins the defaults', () => expect({ ...modelLimits }).toEqual({ embedTimeoutMs: 10000, chatTimeoutMs: 50000, embedBatch: 32, maxReplyTokens: 1024 }));
});

describe('createEmbedder (D15)', () => {
  it('sends nothing for no texts and batches of 32 with normalize and truncate', async () => {
    const tei = await server((b, res) => send(res, 200, (b['inputs'] as string[]).map((_, i) => [i, 0.5])));
    const embed = createEmbedder({ url: tei.url });
    expect(await embed([])).toEqual([]);
    expect(tei.requests).toHaveLength(0);
    expect(await embed(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(40);
    expect(tei.requests.map((r) => [r.method, r.url, (r.body?.['inputs'] as string[]).length, r.body?.['normalize'], r.body?.['truncate']])).toEqual([
      ['POST', '/embed', 32, true, true], ['POST', '/embed', 8, true, true],
    ]);
  });
  it('reads the batch size at call time', async () => {
    const tei = await server((b, res) => send(res, 200, (b['inputs'] as string[]).map(() => [1])));
    modelLimits.embedBatch = 2;
    await createEmbedder({ url: tei.url })(['a', 'b', 'c']);
    expect(tei.requests).toHaveLength(2);
  });
  it('rejects a malformed reply as bad_response', async () => {
    const tei = await server((_b, res) => send(res, 200, [[1, 2], [3]]));
    expect(await code(createEmbedder({ url: tei.url })(['a', 'b']))).toBe('bad_response');
    const nan = await server((_b, res) => res.end('[[null]]'));
    expect(await code(createEmbedder({ url: nan.url })(['a']))).toBe('bad_response');
    const short = await server((_b, res) => send(res, 200, [[1]]));
    expect(await code(createEmbedder({ url: short.url })(['a', 'b']))).toBe('bad_response');
  });
  it('maps an HTTP error and a closed port to unavailable', async () => {
    const bad = await server((_b, res) => send(res, 500, { error: 'x' }));
    expect(await code(createEmbedder({ url: bad.url })(['a']))).toBe('unavailable');
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    expect(await code(createEmbedder({ url: `http://127.0.0.1:${port}` })(['a']))).toBe('unavailable');
  });
});

describe('createChat (D15)', () => {
  const schema = { type: 'object', properties: { relation: { enum: ['same', 'contradicts'] } }, required: ['relation'] };
  const llama = server((b, res) => {
    const first = (b['messages'] as { content: string }[])[0]?.content;
    if (first === 'FAIL') return send(res, 500, { error: 'x' });
    if (first === 'NOCONTENT') return send(res, 200, { choices: [] });
    if (first === 'HANG') return undefined;
    return send(res, 200, { choices: [{ message: { role: 'assistant', content: '{"relation":"same"}' } }] });
  });
  it('rejects other providers at create time', () => {
    expect(() => createChat({ llm: 'anthropic:http://127.0.0.1:1/v1:m' })).toThrow(TypeError);
    expect(() => createChat({ llm: 'openai' })).toThrow(TypeError);
    expect(typeof createChat({ llm: 'openai:http://127.0.0.1:1/v1:qwen2.5-3b' })).toBe('function');
  });
  it('posts the chat body and returns the content unparsed', async () => {
    const l = await llama;
    const chat = createChat({ llm: `openai:${l.url}/v1:qwen2.5-3b` });
    expect(await chat({ messages: [{ role: 'user', content: 'hi' }], schema })).toBe('{"relation":"same"}');
    const r = l.requests.at(-1);
    expect(r?.url).toBe('/v1/chat/completions');
    expect([r?.body?.['model'], r?.body?.['temperature'], r?.body?.['max_tokens'], r?.body?.['response_format']]).toEqual([
      'qwen2.5-3b', 0, 1024, { type: 'json_schema', json_schema: { name: 'reply', schema } },
    ]);
    await chat({ messages: [{ role: 'user', content: 'hi' }], schema, temperature: 0.2 });
    expect(l.requests.at(-1)?.body?.['temperature']).toBe(0.2);
  });
  it('maps status, missing content, timeout and abort to ModelError codes', async () => {
    const l = await llama;
    const ask = (content: string, o: { timeoutMs?: number } = {}, signal?: AbortSignal) =>
      createChat({ llm: `openai:${l.url}/v1:m`, ...o })({ messages: [{ role: 'user', content }], schema }, signal);
    expect(await code(ask('FAIL'))).toBe('unavailable');
    expect(await code(ask('NOCONTENT'))).toBe('bad_response');
    const t0 = Date.now();
    expect(await code(ask('HANG', { timeoutMs: 200 }))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await code(ask('HANG', {}, ac.signal))).toBe('unavailable');
  });
});
