/** Test helpers (not exported from index.ts): fixture documents, a library capability builder, a snapshot of a directory. Temp projects only, never this repository or `~/.claude`. */
import fs from 'node:fs';
import { buildVersion } from '@ctc/core/library';
import type { Repositories } from '@ctc/shared/repositories';

export { scratchRepos, type ScratchRepos } from '../library/testing.ts';
export { cfg, fid, handlerCtx, kit, sid, vec, type Kit, type TestProject } from '../graph/testing.ts';

export const SPEC_PATH = 'specs/900-demo/spec.md';
export const SPEC_LINES = [
  '# Feature Specification: Demo thing', '', '### User Story 1 - Load a file (Priority: P1)',
  '- **FR-001**: The system MUST load files from `src/load.ts::loadFile`.', '- **SC-001**: Load in under 1 s.',
  '```text', '| T9.9 | in fence | x |', '```',
  '| Phase | Task | Done when |', '|---|---|---|',
  '| 1 | T1.1 parse files in `src/parse.ts` and `./lib/a.ts::go` | tests |',
  '| | T1.2 | second cell label | x |',
  '| D1 | pick sqlite | **sqlite**, see `docs/db.md` |',
  '- [x] T1.3 `[P]` [US1] finish checklist item',
  '- [ ] T1.1 duplicate id is ignored',
  '#### T2.0: heading task',
];
export const SPEC_TEXT = `${SPEC_LINES.join('\n')}\n`;
export const SP = (id: string): string => `ctx:specs/900-demo/spec:${id}`;
export const CLAUDE_TEXT = ['# Notes', '', '**Decisions**', '- 2026-10-20 — Built from scratch: refs only, see `src/a.ts::x`. Second sentence.', '- 2026-10-21 - Hyphen separator works.'].join('\n') + '\n';
export const SRC = { 'src/parse.ts': 'export function parse() {}\n', 'lib/a.ts': 'export function go() {}\n', 'docs/db.md': '# DB\n' };

export const skillText = (body: string, name = 'tdd'): string => `---\nname: ${name}\ndescription: Test first\nskills: [plan]\n---\n${body}\n`;

/** Creates (or versions) a library capability for `userId` and serves version 1; returns the stored row. */
export async function capability(repos: Repositories, userId: string, o: { name: string; text: string; kind?: 'skill' | 'agent' | 'command' | 'workflow'; namespace?: string; serve?: boolean }) {
  const kind = o.kind ?? 'skill';
  const main = kind === 'skill' ? 'SKILL.md' : kind === 'workflow' ? 'wf.yaml' : `${o.name}.md`;
  const b = buildVersion({ kind, namespace: o.namespace ?? 'user', defaultName: o.name, rootPath: `/virtual/${kind}s/${o.name}`, mainPath: main, files: [{ path: main, bytes: Buffer.from(o.text) }] });
  if (!b.ok) throw new Error(`fixture capability must build: ${JSON.stringify(b.skip)}`);
  await repos.library.createVersion({ userId }, b.input);
  const cap = await repos.library.byName({ userId }, { namespace: o.namespace ?? 'user', kind, name: o.name });
  if (!cap) throw new Error('capability not created');
  if (o.serve !== false) await repos.library.setServed({ userId }, cap.id, 1);
  const row = await repos.library.get({ userId }, cap.id);
  if (!row) throw new Error('capability not readable');
  return row;
}

/** Path, size and mtime of everything under `dir`, sorted: equal before and after means nothing was written. */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      const st = fs.lstatSync(p);
      out.push(`${p}|${st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
