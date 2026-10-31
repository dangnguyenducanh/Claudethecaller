import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const DIRS = ['apps/web/src/server', 'apps/worker/src/boot', '.claude/metric/eval/switch'];

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : files(path.join(dir, e.name))) : [path.join(dir, e.name)]));
}
const sources = DIRS.flatMap(files).filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts'));
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('new source files (D21, D24)', () => {
  it('there are sources to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it('start with a header that names Called from and Deliberately NOT done', () => {
    for (const f of sources) {
      const head = read(f).replace(/^#!.*\n/, '').slice(0, 1800);
      expect([f, /Called from/i.test(head), /NOT done/i.test(head)]).toEqual([f, true, true]);
    }
  });

  it('never name the live daemon port or the words the owner banned, and never import pg or kysely', () => {
    const banned = /systemctl|pkill|killall|docker\s+(stop|rm|restart)|supabase/i;
    for (const f of sources) {
      const text = read(f);
      expect([f, banned.exec(text)?.[0]]).toEqual([f, undefined]);
      expect([f, /18310/.test(text)]).toEqual([f, false]);
      expect([f, /from\s+['"](pg|kysely)['"]/.test(text)]).toEqual([f, false]);
    }
  });

  it('the mains reuse loadConfigOrExit and assertSchemaVersion, and the worker registers no llm.enrich handler', () => {
    for (const f of ['apps/web/src/server/main.ts', 'apps/worker/src/boot/main.ts']) {
      expect([f, /loadConfigOrExit/.test(read(f)), /assertSchemaVersion/.test(read(f))]).toEqual([f, true, true]);
      expect(read(f).startsWith('#!/usr/bin/env node')).toBe(true);
      expect(fs.statSync(path.join(ROOT, f)).mode & 0o111).not.toBe(0);
    }
    expect(read('apps/worker/src/boot/main.ts') + read('apps/worker/src/boot/compose.ts')).not.toMatch(/['"`]llm\.enrich['"`]\s*:/);
  });
});
