/**
 * Binding of `ctc-web`: the loopback port and the unix socket, with the retry rule of spec:84 (every second for up to 60 s, then give up).
 * Called from: ./main.ts and ./listen.test.ts. Why it exists: after a restart the old process may still hold the port for a moment, and a unit that
 * exits at once would hit its start-rate limit.
 * Deliberately NOT done: building the app (./app.ts), TLS, any listener but these two, removing a socket file that a live process answers on.
 * Untrusted: nothing but the socket path, which comes from the operator's config.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

/**
 * Read at call time. `retryEveryMs` 1,000 and `giveUpMs` 60,000 are spec:84. `socketMaxBytes` 100: the OS limit of a unix socket path is 107 bytes
 * (sockaddr_un), the margin is chosen by judgment.
 */
export const listenLimits = { retryEveryMs: 1000, giveUpMs: 60_000, socketMaxBytes: 100 };

/** The bind did not succeed within `listenLimits.giveUpMs`; the process exits 78. */
export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

type Log = (message: string, fields?: Record<string, unknown>) => void;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function listenOnce(server: http.Server, target: net.ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(target, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Binds `server`, retrying `EADDRINUSE` every `retryEveryMs` until `giveUpMs` have passed (then a `BindError`); any other error is thrown at once. */
export async function bind(server: http.Server, target: net.ListenOptions, log?: Log): Promise<void> {
  const end = Date.now() + listenLimits.giveUpMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await listenOnce(server, target);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      if (Date.now() + listenLimits.retryEveryMs > end) throw new BindError(`could not bind within ${listenLimits.giveUpMs} ms: address in use`);
      log?.('bind retry', { attempt });
      await sleep(listenLimits.retryEveryMs);
    }
  }
}

/** `true` when something accepts connections on the unix socket `file`. */
function answers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(file);
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });
}

export type Listener = { close(): Promise<void> };

/** Listens on `127.0.0.1:<port>` with `handler` (the Fastify `app.routing`). */
export async function listenPort(handler: http.RequestListener, port: number, log?: Log): Promise<Listener> {
  const server = http.createServer(handler);
  await bind(server, { host: '127.0.0.1', port }, log);
  return { close: () => closeServer(server) };
}

/**
 * Listens on the unix socket `file`, mode 0600. A path over `socketMaxBytes` is skipped (`null`, one log line); a socket file nobody answers on is removed
 * first; the file is removed at close.
 */
export async function listenSocket(handler: http.RequestListener, file: string, log?: Log): Promise<Listener | null> {
  if (Buffer.byteLength(file) > listenLimits.socketMaxBytes) {
    log?.('socket skipped', { reason: `path is over ${listenLimits.socketMaxBytes} bytes` });
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !(await answers(file))) fs.rmSync(file, { force: true });
  const server = http.createServer(handler);
  await bind(server, { path: file }, log);
  fs.chmodSync(file, 0o600);
  return {
    async close() {
      await closeServer(server);
      fs.rmSync(file, { force: true });
    },
  };
}

/** Stops accepting, lets requests in flight finish for `graceMs`, then drops what is left. */
export function closeServer(server: http.Server, graceMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => (clearTimeout(timer), resolve()));
    server.closeIdleConnections();
  });
}
