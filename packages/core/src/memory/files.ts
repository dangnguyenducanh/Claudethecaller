/**
 * Claude Code memory files (`~/.claude/projects/<dir>/memory/*.md`): the frontmatter-and-body parser and the project directory name.
 * Called from: apps/worker/src/memory (`memory.import`, `watchMemoryFiles`). Why: spec:524, a fact the user already told Claude Code must
 * reach ctc memories without a second extraction. Deliberately NOT done: reading files, bands, scope or project lookup (the handler decides).
 * Untrusted: every byte of the file; invalid YAML or an unknown `type` gives `null`, never a throw.
 */
import YAML from 'yaml';
import { cleanLine } from './start.ts';
import type { Kind } from './index.ts';

type FileType = 'user' | 'feedback' | 'project' | 'reference';
const KIND_OF: Record<FileType, Kind> = { user: 'preference', feedback: 'convention', project: 'fact', reference: 'fact' };

/** BOM dropped, CRLF read as LF, `---` frontmatter with a mapping that has a known `type`; text is the description else the first prose body line. */
export function parseMemoryFile(text: string): { type: FileType; kind: Kind; text: string } | null {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return null;
  let meta: unknown;
  try {
    meta = YAML.parse(lines.slice(1, end).join('\n'));
  } catch {
    return null;
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  const { type, description } = meta as { type?: unknown; description?: unknown };
  if (typeof type !== 'string' || !Object.hasOwn(KIND_OF, type)) return null;
  const fileType = type as FileType;
  const line =
    typeof description === 'string' && description.trim() !== ''
      ? description
      : (lines.slice(end + 1).find((l) => l.trim() !== '' && !l.trimStart().startsWith('#')) ?? '');
  const clean = cleanLine(line);
  return clean === '' ? null : { type: fileType, kind: KIND_OF[fileType], text: clean };
}

/** The directory name Claude Code gives a project root under `projects/`: every character outside `[A-Za-z0-9]` becomes `-` ([UNVERIFIED] for `_`, `.` and non-ASCII). */
export function projectDirName(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, '-');
}
