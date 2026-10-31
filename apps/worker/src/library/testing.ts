/** Test helpers (not exported from index.ts): a throw-away Postgres schema on the scratch server and temp Claude-home trees. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, createRepositories, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';

export type ScratchRepos = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema `<prefix><random>`; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratchRepos(prefix: string): Promise<ScratchRepos> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `${prefix}${randomBytes(4).toString('hex')}`;
  if (['ctc', 'ctc_eval', 'ctc_own'].includes(schema)) throw new Error('refusing a real schema name');
  await migrate({ url, schema });
  const db = createDb({ url, schema });
  return {
    repos: createRepositories(db),
    schema,
    async drop() {
      try {
        await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
      } finally {
        await db.close();
      }
    },
  };
}

export type TempTree = { dir: string; home(): string; put(file: string, text: string): string; remove(): void };

/** A temp directory under os.tmpdir() holding fake Claude homes; never the real `~/.claude`. */
export function tempTree(): TempTree {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t31-'));
  let n = 0;
  return {
    dir,
    home: () => {
      const h = path.join(dir, `home${++n}`);
      fs.mkdirSync(h, { recursive: true });
      return h;
    },
    put: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const skillMd = (name: string, description: string, body = 'Body text\n'): string => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
export const handlerCtx = (signal: AbortSignal = new AbortController().signal) => ({ jobId: 'j', attempt: 1, signal, setProgress: async () => undefined });
export const unitVec = (i: number): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
export const libConfig = (home: string) => ({
  mode: 'local', claude_home: home, embed_model: 'test-model', embed: { skillret_body_chars: 8000 },
  library: { roots: [home], default_label: 'production', dedup_cosine: 0.92, max_files: 200, max_bytes: 1048576 },
});
