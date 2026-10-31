/**
 * Model clients over `fetch`: the TEI embedder (`POST <url>/embed`) and an OpenAI-style chat client for llama-server
 * (`POST <baseUrl>/chat/completions` with a JSON-schema `response_format`).
 * Called from: apps/worker/src/memory (extract, summarize, judge); later T3.3 / T4.3 / T5.1 (recall, `save_memory`). Why: one place owns the
 * request bodies, the timeouts and the error codes, so no caller hangs and no caller parses transport errors.
 * Deliberately NOT done: retries (the handler decides), parsing of the model's content (the caller does), instruction prefixes for the
 * embedder, streaming, other providers than `openai`.
 * Untrusted: every byte of every reply. Error messages carry no reply body.
 */

export type ChatMessage = { role: 'system' | 'user'; content: string };
export type Embed = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
export type Chat = (req: { messages: ChatMessage[]; schema: object; temperature?: number }, signal?: AbortSignal) => Promise<string>;

/**
 * Read at call time, so a test may assign to it. `embedBatch` 32: TEI `max_client_batch_size` (spec:287). The timeouts fit two chat
 * calls plus embeds inside the 120 s `llm` job timeout (spec:190). `maxReplyTokens` chosen by judgment.
 */
export const modelLimits = { embedTimeoutMs: 10000, chatTimeoutMs: 50000, embedBatch: 32, maxReplyTokens: 1024 };

export type ModelErrorCode = 'unavailable' | 'bad_response' | 'timeout';

/** A model call failed. Not a bad reply: the attempt should fail and be retried by the queue. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message.slice(0, 200));
    this.name = 'ModelError';
    this.code = code;
  }
}

/** POSTs JSON and resolves the parsed reply body; every failure becomes a `ModelError`. The timeout also covers reading the body. */
async function postJson(url: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: both });
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new ModelError('unavailable', `HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof ModelError) throw e;
    if (timeout.aborted) throw new ModelError('timeout', `no reply within ${timeoutMs} ms`);
    if (e instanceof SyntaxError) throw new ModelError('bad_response', 'reply is not JSON');
    throw new ModelError('unavailable', e instanceof Error ? e.name : 'request failed');
  }
}

const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** `embed(texts)`: `[]` for no texts, else batches of `modelLimits.embedBatch`; the reply must be one equal-length finite vector per text. */
export function createEmbedder(o: { url: string; timeoutMs?: number }): Embed {
  const base = o.url.replace(/\/+$/, '');
  return async (texts, signal) => {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += modelLimits.embedBatch) {
      const batch = texts.slice(i, i + modelLimits.embedBatch);
      const reply = await postJson(`${base}/embed`, { inputs: batch, normalize: true, truncate: true }, o.timeoutMs ?? modelLimits.embedTimeoutMs, signal);
      if (!Array.isArray(reply) || reply.length !== batch.length || !reply.every(isVector)) throw new ModelError('bad_response', 'malformed embed reply');
      out.push(...(reply as number[][]));
    }
    const dim = out[0]?.length;
    if (!out.every((v) => v.length === dim)) throw new ModelError('bad_response', 'embed vectors differ in length');
    return out;
  };
}

/** `llm` is `openai:<baseUrl>:<model>`; anything else is a `TypeError` at create time. The reply content is returned unparsed. */
export function createChat(o: { llm: string; timeoutMs?: number; maxTokens?: number }): Chat {
  const first = o.llm.indexOf(':');
  const last = o.llm.lastIndexOf(':');
  if (first < 0 || o.llm.slice(0, first) !== 'openai' || last <= first) throw new TypeError('llm must be openai:<baseUrl>:<model>');
  const base = o.llm.slice(first + 1, last).replace(/\/+$/, '');
  const model = o.llm.slice(last + 1);
  if (base === '' || model === '') throw new TypeError('llm must be openai:<baseUrl>:<model>');
  return async (req, signal) => {
    const body = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_tokens: o.maxTokens ?? modelLimits.maxReplyTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: req.schema } },
    };
    const reply = (await postJson(`${base}/chat/completions`, body, o.timeoutMs ?? modelLimits.chatTimeoutMs, signal)) as
      | { choices?: { message?: { content?: unknown } }[] }
      | null;
    const content = reply?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ModelError('bad_response', 'reply has no message content');
    return content;
  };
}
