/**
 * `ctc:inval` pub/sub: tells every process that a graph, library, override or epoch changed (spec:182).
 * Called from: cache/index.ts (`publishInval`, `subscribeInval`); apps/web registers the callback that reloads its RAM graph.
 * Deliberately NOT done: reloading anything itself, replay of missed messages (the web's 60 s Postgres poll covers them, spec:205).
 */
import { Redis } from 'ioredis';
import { z } from 'zod';
import { errClass, type Core, type createEpochs } from './epoch.ts';

export const InvalMessageSchema = z.object({
  v: z.literal(1),
  event: z.enum(['graph.rebuild', 'library.changed', 'ovr.changed', 'epoch']),
  userId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  kind: z.enum(['graph', 'mem']).optional(),
  epoch: z.string().min(1).optional(),
});
export type InvalMessage = z.infer<typeof InvalMessageSchema>;

const CHANNEL = 'ctc:inval';
/** judgment: how long subscribeInval waits for the first subscription before returning anyway (Redis may be down). */
const SUBSCRIBE_WAIT_MS = 1000;

export function createInval(core: Core, epochs: ReturnType<typeof createEpochs>) {
  const channel = core.ns + CHANNEL;

  return {
    /** Validates and publishes; never throws (invalid message or Redis down: skipped). */
    async publish(msg: unknown): Promise<void> {
      const parsed = InvalMessageSchema.safeParse(msg);
      if (!parsed.success) {
        core.log('inval publish skipped: invalid message');
        return;
      }
      await core.l2((r) => r.publish(channel, JSON.stringify(parsed.data)));
    },
    /** Own connection; callbacks run one at a time, in order; an error in `cb` never stops delivery. */
    async subscribe(cb: (msg: InvalMessage) => void | Promise<void>): Promise<{ close(): Promise<void> }> {
      let closed = false;
      let warned = false;
      let chain: Promise<void> = Promise.resolve();
      const sub = new Redis(core.url, {
        enableReadyCheck: false,
        autoResubscribe: false,
        retryStrategy: (n) => Math.min(50 * n, 1000),
      });
      let firstSubscribed!: () => void;
      const first = new Promise<void>((res) => (firstSubscribed = res));

      const handle = async (raw: string): Promise<void> => {
        let obj: unknown;
        try {
          obj = JSON.parse(raw);
        } catch {
          return;
        }
        const parsed = InvalMessageSchema.safeParse(obj);
        if (!parsed.success) {
          if (!warned) core.log('inval message ignored: unknown shape, event or version');
          warned = true;
          return;
        }
        const msg = parsed.data;
        if (msg.event === 'epoch') {
          if (msg.kind && msg.projectId && msg.epoch) epochs.adopt(msg.kind, msg.userId, msg.projectId, msg.epoch);
        } else {
          core.clearL1();
        }
        try {
          await cb(msg);
        } catch (e) {
          core.log('inval callback failed', { error: errClass(e) });
        }
      };

      sub.on('error', (e) => core.log('inval subscriber error', { error: errClass(e) }));
      sub.on('ready', () => {
        sub
          .subscribe(channel)
          .then(() => {
            // messages may have been missed while the connection was down
            if (!closed) core.clearL1();
            firstSubscribed();
          })
          .catch((e: unknown) => core.log('inval subscribe failed', { error: errClass(e) }));
      });
      sub.on('message', (_channel: string, raw: string) => {
        if (!closed) chain = chain.then(() => (closed ? undefined : handle(raw)));
      });

      let timer: NodeJS.Timeout | undefined;
      await Promise.race([first, new Promise<void>((res) => (timer = setTimeout(res, SUBSCRIBE_WAIT_MS)))]);
      clearTimeout(timer);

      return {
        async close(): Promise<void> {
          closed = true;
          sub.disconnect(); // ends the subscription server-side
        },
      };
    },
  };
}
