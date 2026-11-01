/**
 * Doc extract prompt and reply validation for the `graph.extract` job.
 *
 * Called from: the worker extract job (context/extract.ts). Why it exists: spec:284 (a model adds `implements` / `decides` edges the parsers cannot see, marked INFERRED), DECISIONS D14.
 * Deliberately NOT done: running the model, JSON repair beyond three extraction forms, resolving the targets (refs.ts).
 * Untrusted: the document text (sanitized before it is sent) and the model reply (data: only validated strings are used, the message of a failure never contains reply text).
 */
import { cleanLabel, fileStem } from '../graph/ids.ts';
import { sanitize } from '../sanitize/index.ts';
import { contextLimits } from './limits.ts';
import { REF_BODY } from './parse.ts';
import type { ExtractReply } from './types.ts';

const REPLY_LINE = 'Reply with JSON only: {"edges":[{"from":"<id>","relation":"implements|decides","to":"<path>[::symbol]"}]}';
const TARGET = new RegExp(`^${REF_BODY}$`);
const FENCED = /```(?:json)?[ \t]*\n([\s\S]*?)```/;
const localIdOf = (file: string, id: string): string | null => {
  const prefix = `ctx:${fileStem(file)}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
};
const cutPoints = (s: string, max: number): string => (s.length <= max ? s : Array.from(s.slice(0, max * 2)).slice(0, max).join(''));

/**
 * The prompt for one document: instructions, one line per node (`<localId> | <type> | <label>`), the sanitized document between `<<<DOC` and `DOC>>>`,
 * and the fixed reply line last. Deterministic; never throws.
 */
export function buildExtractPrompt(o: { file: string; text: string; nodes: { id: string; type: string; label: string }[] }): string {
  try {
    const nodeLines = o.nodes.flatMap((n) => {
      const local = localIdOf(o.file, n.id);
      return local === null ? [] : [`${sanitize(local).replace(/\s+/g, ' ')} | ${n.type} | ${sanitize(cleanLabel(n.label)).replace(/\s+/g, ' ')}`];
    });
    // judgment: the document may contain the delimiter lines, so they are broken up instead of letting the text close the block early
    const doc = cutPoints(sanitize(o.text), contextLimits.maxPromptChars).replaceAll('<<<DOC', '<<< DOC').replaceAll('DOC>>>', 'DOC >>>');
    return [
      `You read one project document (${sanitize(cleanLabel(o.file))}) and link its tasks and decisions to the code they change.`,
      'Use no tools. Name only file paths that are written in the document or listed in it. Never invent a path.',
      'Nodes (<id> | <type> | <label>); use `implements` for a task and `decides` for a decision:',
      ...nodeLines,
      '<<<DOC',
      doc,
      'DOC>>>',
      REPLY_LINE,
    ].join('\n');
  } catch {
    return REPLY_LINE;
  }
}

function candidates(reply: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string): void => {
    try {
      out.push(JSON.parse(s));
    } catch {
      // not JSON: the next form is tried
    }
  };
  tryParse(reply.trim());
  const fenced = FENCED.exec(reply);
  if (fenced) tryParse((fenced[1] as string).trim());
  const a = reply.indexOf('{');
  const b = reply.lastIndexOf('}');
  if (a >= 0 && b > a) tryParse(reply.slice(a, b + 1));
  return out;
}

const bad: ExtractReply = { ok: false, code: 'bad_reply', message: 'the reply is not a JSON object with an edges array' };

/**
 * Validates a model reply. JSON is read from the trimmed reply, the first fenced block, or the first `{` to the last `}`. An item is kept iff `from` is the local id of a
 * node of `o.nodes`, `relation` is `implements` (task) or `decides` (decision) and `to` is exactly one path or `path::symbol`. Never throws.
 */
export function parseExtractReply(reply: string, o: { file: string; nodes: { id: string; type: string }[] }): ExtractReply {
  try {
    if (typeof reply !== 'string') return bad;
    const doc = candidates(reply).find((c): c is { edges: unknown[] } => typeof c === 'object' && c !== null && !Array.isArray(c) && Array.isArray((c as { edges?: unknown }).edges));
    if (!doc) return bad;
    const byLocal = new Map<string, { id: string; type: string }>();
    for (const n of o.nodes) {
      const local = localIdOf(o.file, n.id);
      if (local !== null) byLocal.set(local, n);
    }
    const edges: Extract<ExtractReply, { ok: true }>['edges'] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const item of doc.edges) {
      const it = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
      const node = it && typeof it['from'] === 'string' ? byLocal.get(it['from']) : undefined;
      const relation = it?.['relation'];
      const to = it && typeof it['to'] === 'string' ? it['to'].trim().replace(/^\.\//, '') : '';
      const m = TARGET.exec(to);
      const ok = node && ((relation === 'implements' && node.type === 'task') || (relation === 'decides' && node.type === 'decision')) && m !== null && !(m[1] as string).split('/').some((s) => s === '.' || s === '..');
      if (!ok || edges.length >= contextLimits.maxModelEdges) {
        dropped++;
        continue;
      }
      const key = `${node.id}\0${relation}\0${to}`;
      if (seen.has(key)) {
        dropped++;
        continue;
      }
      seen.add(key);
      edges.push({ src: node.id, relation: relation as 'implements' | 'decides', kind: m[2] === undefined ? 'path' : 'path_symbol', target: to });
    }
    return { ok: true, edges, dropped };
  } catch {
    return bad;
  }
}
