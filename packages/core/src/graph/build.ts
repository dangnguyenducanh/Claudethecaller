/**
 * Result builder and tree walker shared by the language extractors.
 *
 * Called from: `tsjs.ts`, `python.ts`, `bash.ts`, `json.ts`, `sql.ts`, `markdown.ts`. Why it exists: one place that
 * enforces D6/D17 (unique ids, first duplicate wins, document order, one `contains` edge per child, deduplicated raw
 * refs and mentions). Deliberately NOT done: any language knowledge, any I/O.
 */
import type { Node } from 'web-tree-sitter';
import { cleanLabel, makeId } from './ids.ts';
import { MAX_WALK_DEPTH } from './types.ts';
import type { ExtractedEdge, ExtractedNode, NodeType, RawImport, RawMention, RawRef } from './types.ts';

export interface NodeSpec {
  /** Symbol names after the file stem, outer to inner (`['Class', 'method']`). */
  names: string[];
  type: NodeType;
  label: string;
  startLine: number;
  startCol: number;
  endLine: number;
  /** Id of the parent node (the file node for top-level symbols). */
  parent: string;
}

export interface Out {
  readonly fileId: string;
  readonly totalLines: number;
  /** Normalised source text the tree was parsed from (node indexes are offsets into it). */
  readonly source: string;
  /** Full node id (`code:`/`doc:` prefix included) for the given symbol names. */
  idOf(...names: string[]): string;
  /** Adds a node; returns false (and adds nothing) when the id already exists (first occurrence wins). */
  add(spec: NodeSpec): boolean;
  /** Same as `add` for an id that is not `idOf(...names)` (bash entry node, markdown headings). */
  addWithId(id: string, spec: Omit<NodeSpec, 'names'>): boolean;
  has(id: string): boolean;
  addImport(imp: Omit<RawImport, 'from'>): void;
  addRef(ref: RawRef): void;
  addMention(m: RawMention): void;
  finish(): { nodes: ExtractedNode[]; edges: ExtractedEdge[]; imports: RawImport[]; refs: RawRef[]; mentions: RawMention[] };
}

interface Pending {
  node: ExtractedNode;
  parent: string | null;
  col: number;
}

export function createOut(path: string, stem: string, kind: 'code' | 'doc', source: string, totalLines: number): Out {
  const prefix = `${kind}:`;
  const pending: Pending[] = [];
  const ids = new Set<string>();
  const imports: RawImport[] = [];
  const refs: RawRef[] = [];
  const mentions: RawMention[] = [];
  const refKeys = new Set<string>();
  const mentionKeys = new Set<string>();
  const fileId = prefix + makeId(stem);
  const baseName = path.slice(path.lastIndexOf('/') + 1);

  const push = (id: string, type: NodeType, label: string, startLine: number, startCol: number, endLine: number, parent: string | null): boolean => {
    if (ids.has(id)) return false;
    ids.add(id);
    pending.push({
      node: {
        id,
        kind,
        type,
        label: cleanLabel(label),
        sourceLocation: `L${startLine}`,
        meta: { lines: [startLine, Math.max(startLine, endLine)] },
      },
      parent,
      col: startCol,
    });
    return true;
  };
  push(fileId, kind === 'doc' ? 'page' : 'file', baseName, 1, 0, totalLines, null);

  const out: Out = {
    fileId,
    totalLines,
    source,
    idOf: (...names) => prefix + makeId(stem, ...names),
    add: (spec) => push(prefix + makeId(stem, ...spec.names), spec.type, spec.label, spec.startLine, spec.startCol, spec.endLine, spec.parent),
    addWithId: (id, spec) => push(id, spec.type, spec.label, spec.startLine, spec.startCol, spec.endLine, spec.parent),
    has: (id) => ids.has(id),
    addImport: (imp) => {
      imports.push({ from: fileId, ...imp });
    },
    addRef: (ref) => {
      const key = `${ref.from}\0${ref.kind}\0${ref.name}\0${ref.receiver ?? ''}`;
      if (refKeys.has(key)) return;
      refKeys.add(key);
      refs.push(ref);
    },
    addMention: (m) => {
      const key = `${m.from}\0${m.kind}\0${m.target}`;
      if (mentionKeys.has(key)) return;
      mentionKeys.add(key);
      mentions.push(m);
    },
    finish: () => {
      // Document order: start line, then start column; ties keep insertion order (outer nodes are added first).
      const sorted = pending
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.node.meta.lines[0] - b.p.node.meta.lines[0] || a.p.col - b.p.col || a.i - b.i)
        .map((x) => x.p);
      // The file node always leads: it starts at line 1 column 0, so any tie is broken by insertion order already.
      const edges: ExtractedEdge[] = [];
      for (const p of sorted) {
        if (p.parent === null) continue;
        edges.push({ src: ids.has(p.parent) ? p.parent : fileId, dst: p.node.id, relation: 'contains', confidence: 'EXTRACTED', sourceLocation: p.node.sourceLocation });
      }
      return { nodes: sorted.map((p) => p.node), edges, imports, refs, mentions };
    },
  };
  return out;
}

/**
 * Pre-order walk with a tree cursor, bounded at `MAX_WALK_DEPTH`. `enter` gets the node and its depth (root = 1) and
 * returns false to skip the node's children. Never recurses.
 */
export function walkTree(root: Node, enter: (node: Node, depth: number) => boolean): void {
  const cursor = root.walk();
  try {
    let depth = 1;
    for (;;) {
      const descend = enter(cursor.currentNode, depth) && depth < MAX_WALK_DEPTH;
      if (descend && cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

/** 1-based inclusive end line of a node; a node that ends at column 0 of a later row ends on the row before. */
export function endLineOf(node: Node): number {
  const end = node.endPosition;
  const start = node.startPosition;
  return end.column === 0 && end.row > start.row ? end.row : end.row + 1;
}

/**
 * Source text with whitespace runs collapsed to one space, cut to `max` code points. Looks at a growing prefix only,
 * so a huge node (a long call chain) costs O(max), not O(node size).
 */
export function squashText(text: string, max: number): string {
  for (let k = Math.max(max * 2, 64); ; k *= 4) {
    const s = text.slice(0, k).replace(/\s+/g, ' ');
    if (k >= text.length || s.length > max * 2) return s.length <= max ? s : Array.from(s).slice(0, max).join('');
  }
}
