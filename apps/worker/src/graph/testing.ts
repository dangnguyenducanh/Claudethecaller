/** Test helpers (not exported from index.ts): temp projects under os.tmpdir() with a `projects` row, never this repository or `~/.claude`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGrammars, makeId, fileStem } from '@ctc/core/graph';
import type { Grammars } from '@ctc/core/graph';
import type { Repositories } from '@ctc/shared/repositories';
import { rebuildProject, type GraphConfig, type RebuildResult } from './index.ts';

export const LANGS = ['ts', 'tsx', 'js', 'python', 'bash', 'sql', 'json', 'markdown'];
export const cfg = (o: Partial<GraphConfig['graph']> = {}): GraphConfig => ({ mode: 'local', graph: { languages: LANGS, shrink_guard: 0.2, debounce_s: 3, ...o } });
export const fid = (p: string): string => `code:${makeId(fileStem(p))}`;
export const sid = (p: string, ...names: string[]): string => `code:${makeId(fileStem(p), ...names)}`;
export const fns = (n: number): string => Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join('\n') + '\n';
export const vec = (): number[] => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
export const handlerCtx = (o: Partial<{ jobId: string; signal: AbortSignal }> = {}) => ({ jobId: 'j', attempt: 1, signal: new AbortController().signal, setProgress: async () => undefined, ...o });

export type TestProject = { root: string; ctx: { userId: string; projectId: string }; put(rel: string, text: string): string; remove(rel: string): void };
export type Kit = { tmp: string; grammars: Grammars; project(files?: Record<string, string>, userId?: string): Promise<TestProject>; rebuild(p: TestProject, o?: Record<string, unknown>): Promise<RebuildResult>; cleanup(): void };

export async function kit(repos: Repositories): Promise<Kit> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t22-'));
  const grammars = await loadGrammars();
  let n = 0;
  const put = (root: string, rel: string, text: string): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  const project = async (files: Record<string, string> = {}, userId = 'local'): Promise<TestProject> => {
    const root = path.join(tmp, `p${++n}`);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, text] of Object.entries(files)) put(root, rel, text);
    const p = await repos.projects.upsert({ userId }, { root });
    return { root, ctx: { userId, projectId: p.id }, put: (rel, text) => put(root, rel, text), remove: (rel) => fs.rmSync(path.join(root, rel)) };
  };
  return {
    tmp, grammars, project,
    rebuild: (p, o = {}) => rebuildProject({ repos, ctx: p.ctx, root: p.root, config: cfg(), grammars, ...o }),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
