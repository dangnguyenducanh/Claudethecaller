/**
 * Deletes the keys of one Redis namespace through a bare RESP connection (`SCAN` + `DEL`).
 * Called from: the `*.int.test.ts` files of this directory, in `afterAll`. Why it exists: a test instance leaves cache and BullMQ keys under its private
 * namespace, and apps/web has no Redis client of its own (ioredis is a dependency of packages/shared and apps/worker only); unremoved keys make the
 * scratch database large, and the single-call `SCAN` of earlier tests then misses its key.
 * Deliberately NOT done: any command but `SCAN` and `DEL`, a pattern other than `<namespace>*`, a namespace shorter than 4 characters (refused, so a
 * mistake can never clear a whole database), authentication, TLS, pipelining.
 * Untrusted: nothing; the arguments come from the test that owns the namespace.
 */
import net from 'node:net';

type Reply = string | number | null | Reply[];

/** Parses one RESP2 reply from the start of `buf`; `null` when more bytes are needed. */
function parse(buf: Buffer, at = 0): { value: Reply; next: number } | null {
  const eol = buf.indexOf('\r\n', at);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[at] as number);
  const line = buf.toString('utf8', at + 1, eol);
  if (type === '+' || type === '-') return { value: type === '-' ? `ERR ${line}` : line, next: eol + 2 };
  if (type === ':') return { value: Number(line), next: eol + 2 };
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return { value: null, next: eol + 2 };
    if (buf.length < eol + 2 + n + 2) return null;
    return { value: buf.toString('utf8', eol + 2, eol + 2 + n), next: eol + 2 + n + 2 };
  }
  if (type === '*') {
    const items: Reply[] = [];
    let pos = eol + 2;
    for (let i = 0; i < Number(line); i++) {
      const item = parse(buf, pos);
      if (item === null) return null;
      items.push(item.value);
      pos = item.next;
    }
    return { value: items, next: pos };
  }
  throw new Error('unexpected RESP reply');
}

const encode = (args: string[]): string => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

/** Removes every key that starts with `namespace`; resolves with the number removed. Never throws: a Redis that is not there has nothing to clean. */
export async function deleteNamespace(redisUrl: string, namespace: string): Promise<number> {
  if (namespace.length < 4 || /[*?[\]\\]/.test(namespace)) throw new Error('namespace must be at least 4 characters without glob characters');
  const u = new URL(redisUrl);
  const socket = net.connect({ host: u.hostname, port: Number(u.port || 6379) });
  let buf = Buffer.alloc(0);
  const waiting: ((r: Reply) => void)[] = [];
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (let r = parse(buf); r !== null && waiting.length > 0; r = parse(buf)) {
      buf = buf.subarray(r.next);
      (waiting.shift() as (v: Reply) => void)(r.value);
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => waiting.splice(0).forEach((w) => w(null)));
  const call = (...args: string[]): Promise<Reply> => new Promise((resolve) => (waiting.push(resolve), socket.write(encode(args))));
  try {
    await new Promise<void>((resolve, reject) => (socket.once('connect', resolve), socket.once('error', reject)));
    const dbIndex = u.pathname.replace('/', '');
    if (dbIndex !== '' && dbIndex !== '0') await call('SELECT', dbIndex);
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = (await call('SCAN', cursor, 'MATCH', `${namespace}*`, 'COUNT', '1000')) as [string, string[]];
      cursor = next;
      if (keys.length > 0) removed += (await call('DEL', ...keys)) as number;
    } while (cursor !== '0');
    return removed;
  } catch {
    return 0;
  } finally {
    socket.destroy();
  }
}
