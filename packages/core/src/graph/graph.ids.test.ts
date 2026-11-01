import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFile, loadGrammars, makeId } from './index.ts';
import type { Grammars } from './index.ts';

interface GoldenNode {
  id: string;
  label: string;
  line: string;
  parent: string | null;
}
interface Golden {
  files: Record<string, { nodes: GoldenNode[] }>;
  make_id: { parts: string[]; id: string }[];
}

const FIXTURES = new URL('./__fixtures__/ids/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('ids.json', FIXTURES), 'utf8')) as Golden;
const strip = (id: string | undefined): string | null => (id ? id.replace(/^(code|doc):/, '') : null);
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : 1);

describe('graph.ids', () => {
  let grammars: Grammars;
  beforeAll(async () => {
    grammars = await loadGrammars();
  });

  for (const [path, want] of Object.entries(golden.files)) {
    it(`${path} matches graphify 0.9.93 ids, labels, lines and parents`, () => {
      const content = readFileSync(new URL(`src/${path}.txt`, FIXTURES), 'utf8');
      const r = extractFile({ path, content }, grammars);
      expect(r.error).toBeNull();
      const parentOf = new Map(r.edges.map((e) => [e.dst, e.src]));
      const got = r.nodes
        .map((n) => ({ id: strip(n.id) as string, label: n.label, line: n.sourceLocation, parent: strip(parentOf.get(n.id)) }))
        .sort(byId);
      expect(got.map((n) => n.id)).toEqual(want.nodes.map((n) => n.id).sort());
      expect(got).toEqual([...want.nodes].sort(byId));
    });
  }

  it('make_id vectors match', () => {
    expect(golden.make_id.map((m) => makeId(...m.parts))).toEqual(golden.make_id.map((m) => m.id));
  });
});
