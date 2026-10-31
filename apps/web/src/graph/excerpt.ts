/**
 * `readExcerpt`: the source lines of one graph node, for `graph_explain` and `GET /api/graph/explain`. Called from: tools.ts and routes.ts.
 * Why: spec:326 shows the node's source (at most 40 lines) next to its edges. Deliberately NOT done: cleaning the text (core `explainNode`
 * does that), writing files, following a path outside the project root. Untrusted: `node.sourceFile` and `node.meta` (database rows, possibly from
 * `ctc migrate --from-python`) and the file text.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryLimits, type GNode } from '@ctc/core/graph/query';

export type ReadText = (root: string, rel: string) => Promise<string | null>;

/** Larger files are not read (chosen by judgment). */
const MAX_BYTES = 1_000_000;
/** A NUL in the first bytes marks a binary file (the rule git uses). */
const BINARY_PROBE = 8000;

/** A project-relative path made of plain segments: no empty, `.` or `..` segment, no NUL, not absolute. */
function isPlainRelative(rel: unknown): rel is string {
  return typeof rel === 'string' && rel !== '' && !rel.includes('\0') && !rel.startsWith('/') && rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** D1d: the whole text of a regular UTF-8 file whose real path is under the real project root, else `null`. Never throws. */
export const readUnderRoot: ReadText = async (root, rel) => {
  try {
    if (!isPlainRelative(rel)) return null;
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(path.join(realRoot, rel));
    if (!real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) return null;
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = await fs.readFile(real);
    if (buf.subarray(0, BINARY_PROBE).includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
};

const intIn = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** The 1-based inclusive line range of the node: `meta.lines`, else the `L<N>` of `sourceLocation` plus `excerptLines`; `null` when it has neither. */
function rangeOf(node: GNode): { start: number; end: number } | null {
  const lines = (node.meta as { lines?: unknown } | null | undefined)?.lines;
  if (Array.isArray(lines) && intIn(lines[0]) && intIn(lines[1]) && lines[1] >= lines[0]) return { start: lines[0], end: lines[1] };
  const m = typeof node.sourceLocation === 'string' ? /^L(\d+)$/.exec(node.sourceLocation) : null;
  return m && Number(m[1]) >= 1 ? { start: Number(m[1]), end: Number(m[1]) + queryLimits.excerptLines - 1 } : null;
}

/** D13: at most `excerptLines` lines starting at the node's first line, or `null`. The path is checked here for every reader, a custom `readText` included. */
export async function readExcerpt(root: string, node: GNode, readText: ReadText = readUnderRoot): Promise<string | null> {
  try {
    if (!isPlainRelative(node.sourceFile)) return null;
    const range = rangeOf(node);
    if (range === null) return null;
    const text = await readText(root, node.sourceFile);
    if (typeof text !== 'string') return null;
    const slice = text.split('\n').slice(range.start - 1, Math.min(range.end, range.start + queryLimits.excerptLines - 1));
    return slice.length === 0 ? null : slice.join('\n');
  } catch {
    // judgment: a failed read is `null`, never an error (D1d)
    return null;
  }
}
