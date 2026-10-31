/**
 * Public types and tunables of the graph extractor.
 *
 * Called from: every module in this directory; re-exported by `index.ts` for `apps/worker` (T2.2 graph jobs) and the
 * context parsers (T2.3). Why it exists: one place for the shapes `extractFile` returns, which are assignable to
 * `GraphNodeInput` / `GraphEdgeInput` in `packages/shared/src/repositories/graph.ts`. Deliberately NOT done: no
 * resolution of references (T2.2), no I/O.
 */

/** Config names of the supported languages (`graph.languages`). */
export type Lang = 'ts' | 'tsx' | 'js' | 'python' | 'bash' | 'sql' | 'json' | 'markdown';

export type NodeType = 'file' | 'class' | 'interface' | 'type' | 'function' | 'method' | 'variable' | 'key' | 'table' | 'page' | 'heading';

export type ExtractErrorCode = 'bad_path' | 'unsupported' | 'too_large' | 'parse_timeout' | 'grammar_missing' | 'internal';

export interface ExtractInput {
  /** Repo-relative path using `/`; validated by `extractFile`. */
  path: string;
  /** Untrusted file text. */
  content: string;
}

export interface ExtractedNode {
  id: string;
  kind: 'code' | 'doc';
  type: NodeType;
  label: string;
  /** `L<start line>`, 1-based. */
  sourceLocation: string;
  /** `[start, end]`, 1-based inclusive. */
  meta: { lines: [number, number] };
}

export interface ExtractedEdge {
  src: string;
  dst: string;
  relation: 'contains';
  confidence: 'EXTRACTED';
  sourceLocation: string;
}

export interface RawImport {
  /** The file node id. */
  from: string;
  specifier: string;
  names: { imported: string; local: string }[];
  typeOnly: boolean;
  kind: 'import' | 'reexport' | 'require' | 'dynamic' | 'source';
  line: number;
}

export interface RawRef {
  from: string;
  name: string;
  receiver: string | null;
  kind: 'call' | 'new' | 'jsx' | 'extends' | 'implements';
  line: number;
}

export interface RawMention {
  from: string;
  kind: 'symbol' | 'path_symbol' | 'link';
  target: string;
  line: number;
}

export interface ExtractResult {
  file: string;
  lang: Lang | null;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  imports: RawImport[];
  refs: RawRef[];
  mentions: RawMention[];
  error: { code: ExtractErrorCode; message: string } | null;
}

/**
 * Mutable limits, read at call time (a test may assign to a field and restore it). The values are the ones named in
 * DECISIONS D2; `maxFileBytes` and `maxLabelChars` come from the spec (skip files over 1 MB, labels capped at 256),
 * the JSON and frontmatter values are graphify 0.9.93's, the other two were chosen by judgment.
 */
export const limits = {
  maxFileBytes: 1_048_576,
  parseTimeoutMs: 5000,
  maxLabelChars: 256,
  jsonMaxDepth: 6,
  jsonMaxPairs: 500,
  frontmatterMaxLines: 200,
  maxReceiverChars: 128,
};

/** Stored in `graph_sources.extractor_version`; bump on any change to ids, node rules or raw shapes. */
export const EXTRACTOR_VERSION = 'ctc-ts-1';

/** Tree walks stop descending below this depth (D6, judgment: deep enough for real code, bounded for hostile files). */
export const MAX_WALK_DEPTH = 2000;
