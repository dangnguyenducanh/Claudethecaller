// Rebuilds vectors.jsonl for the memory eval set: one line per corpus memory and per query,
// {id, sha1: sha1(text), v: base64 of 1024 little-endian float32}. Plain text, no instruction prefix (T4.2 D15: memories are
// embedded as plain text), TEI normalize + truncate, batches of 32 (TEI max_client_batch_size).
// Run from anywhere: node embed.mjs   (env CTC_EMBED_URL, default http://127.0.0.1:18300; loopback only)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const url = process.env.CTC_EMBED_URL ?? 'http://127.0.0.1:18300';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error(`refusing non-loopback embedder ${url}`);
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const items = [...read('corpus.jsonl').map((m) => ({ id: m.id, text: m.text })), ...read('queries.jsonl').map((q) => ({ id: q.id, text: q.query }))];
const out = [];
for (let i = 0; i < items.length; i += 32) {
  const batch = items.slice(i, i + 32);
  const res = await fetch(`${url}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: batch.map((b) => b.text), normalize: true, truncate: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const vecs = await res.json();
  batch.forEach((b, j) => {
    const v = vecs[j];
    if (!Array.isArray(v) || v.length !== 1024) throw new Error(`bad vector for ${b.id}`);
    const sha1 = createHash('sha1').update(b.text, 'utf8').digest('hex');
    out.push(JSON.stringify({ id: b.id, sha1, v: Buffer.from(new Float32Array(v).buffer).toString('base64') }));
  });
}
fs.writeFileSync(path.join(here, 'vectors.jsonl'), out.join('\n') + '\n');
console.log(`vectors.jsonl: ${out.length} vectors`);
