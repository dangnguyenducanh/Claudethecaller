/**
 * The band ports: how one fact meets the memories already stored (embed, nearest neighbour, judge, reinforce, rewrite, supersede, add).
 * Called from: apps/worker/src/memory (`llm.extract`, `memory.import`) and apps/web/src/memory (`save_memory`). Why: one implementation of
 * `applyBands`' ports for the web and the worker. Deliberately NOT done: the band decision (`applyBands`), cache epochs, logging.
 * Untrusted: every model reply (a failed or invalid judge is `null`, which keeps both rows).
 */
import { memoryHash } from '@ctc/shared/memory-hash';
import { ModelError, type Chat, type Embed } from '@ctc/shared/models';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { parseRelationReply, relationMessages, RELATION_SCHEMA, type BandPorts, type Fact } from './index.ts';

export type BandPortDeps = {
  memory: Pick<Repositories['memory'], 'nearest' | 'reinforce' | 'rewrite' | 'supersede' | 'add'>;
  embed: Embed;
  chat: Chat;
  today: () => string;
};

/** Ports over the repository. `o.reinforce === false` makes `reinforce` a no-op (a file read again is not a new reason to remember). */
export function bandPorts(deps: BandPortDeps, ctx: Ctx, o: { source: unknown; signal?: AbortSignal; reinforce?: boolean }): BandPorts {
  const { memory, embed, chat, today } = deps;
  const { signal } = o;
  const input = (fact: Fact, embedding: number[]) => ({ scope: fact.scope, kind: fact.kind, text: fact.text, embedding, confidence: fact.confidence, source: o.source });
  return {
    embed: async (text) => {
      const [v] = await embed([text], signal);
      if (!v) throw new ModelError('bad_response', 'no vector');
      return v;
    },
    nearest: async (scope, embedding) => {
      const [n] = await memory.nearest(ctx, { scope, embedding, limit: 1 });
      return n ? { id: n.memory.id, text: n.memory.text, similarity: n.similarity } : null;
    },
    judge: async (oldText, newText) => {
      try {
        return parseRelationReply(await chat({ messages: relationMessages(oldText, newText), schema: RELATION_SCHEMA, temperature: 0 }, signal));
      } catch (e) {
        if (signal?.aborted || !(e instanceof ModelError)) throw e;
        return null; // judgment: no verdict keeps both rows
      }
    },
    reinforce: async (id) => {
      if (o.reinforce !== false) await memory.reinforce(ctx, id, today());
    },
    rewrite: async (id, text, embedding) => memory.rewrite(ctx, id, { text, embedding, hash: memoryHash(text) }),
    supersede: async (oldId, fact, embedding) => memory.supersede(ctx, oldId, input(fact, embedding)),
    add: async (fact, embedding) => memory.add(ctx, input(fact, embedding)),
  };
}
