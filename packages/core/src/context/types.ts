/** Shapes shared by the context parsers (DECISIONS D3, D9, D12, D14). Strict types, no behaviour. */

export type CtxNode = {
  id: string;
  kind: 'context' | 'capability';
  type: 'spec' | 'requirement' | 'task' | 'decision' | 'skill' | 'agent' | 'command' | 'workflow' | 'workflow_step';
  label: string;
  sourceLocation: string | null;
  contentHash: string;
  meta: Record<string, unknown>;
};

export type CtxEdge = {
  src: string;
  dst: string;
  relation: 'part_of' | 'uses' | 'invokes' | 'contains';
  confidence: 'EXTRACTED';
  score: 1;
  sourceLocation: string | null;
};

export type CtxRef = { from: string; relation: 'implements' | 'decides' | 'part_of'; kind: 'path' | 'path_symbol' | 'node'; target: string; line: number };

export type ContextParse = {
  file: string;
  nodes: CtxNode[];
  edges: CtxEdge[];
  refs: CtxRef[];
  truncated: boolean;
  error: null | { code: 'bad_path' | 'too_large' | 'internal'; message: string };
};

/** A stored graph node as `resolveRefs` needs it (a `GraphNode` row is assignable). */
export type RefNode = { id: string; type: string; label: string; sourceFile: string | null };

export type ResolvedRef = {
  src: string;
  dst: string;
  relation: string;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  score: number;
  sourceLocation: string;
};

export type CapabilityInput = {
  kind: 'skill' | 'agent' | 'command' | 'workflow';
  name: string;
  description: string;
  frontmatter: unknown;
  body: string;
  servedVersion: number | null;
  bodyHash: string;
};

export type CapabilityParse = { nodes: CtxNode[]; edges: CtxEdge[]; hash: string };

export type ExtractReply =
  | { ok: true; edges: { src: string; relation: 'implements' | 'decides'; kind: 'path' | 'path_symbol'; target: string }[]; dropped: number }
  | { ok: false; code: 'bad_reply'; message: string };
