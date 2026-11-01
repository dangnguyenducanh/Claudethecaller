/**
 * Cache key builders. Called from: apps/web (hooks, auth, rate limit). Why: two different tuples must never build the
 * same key, so every caller-supplied part is checked (no colon, no whitespace, 1..128 chars) and prompts are hashed.
 * Deliberately NOT done: namespacing (the cache adds it), TTLs (limits.ts).
 */
import { createHash } from 'node:crypto';

const PART = /^[^:\s]{1,128}$/;

/** Throws a synchronous `TypeError('invalid key part: <name>')` for a part that could collide with another key. */
export function keyPart(name: string, value: unknown): string {
  if (typeof value !== 'string' || !PART.test(value)) throw new TypeError(`invalid key part: ${name}`);
  return value;
}

const sha1 = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex');

/** Pseudo project id of the memory epoch that guards the user's global memories (a change to one reaches every project's cached start block). */
export const GLOBAL_MEM_EPOCH = '*';

/** `cwd` and `text` are free-form (hashed or last part); everything else goes through `keyPart`. */
export const keys = {
  emb: (text: string): string => `emb:${sha1(text)}`,
  sug: (user: string, project: string, prompt: string, graphEpoch: string): string =>
    `sug:${keyPart('user', user)}:${keyPart('project', project)}:${sha1(prompt)}:${keyPart('graphEpoch', graphEpoch)}`,
  proj: (user: string, cwd: string): string => `proj:${keyPart('user', user)}:${cwd}`,
  ovr: (user: string, project: string): string => `ovr:${keyPart('user', user)}:${keyPart('project', project)}`,
  ctx: (user: string, project: string, memEpoch: string): string =>
    `ctx:${keyPart('user', user)}:${keyPart('project', project)}:${keyPart('memEpoch', memEpoch)}`,
  key: (hash: string): string => `key:${keyPart('hash', hash)}`,
  rl: (user: string, minute: number): string => {
    if (!Number.isInteger(minute)) throw new TypeError('invalid key part: minute');
    return `rl:${keyPart('user', user)}:${minute}`;
  },
};
