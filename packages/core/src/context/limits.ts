/** Tunables and version of the context parsers. Mutable objects read at call time, so a test may assign to a field and restore it. Values: DECISIONS D2, D3. */

/** Bump on any change to ids, labels or rules: it is part of every `contentHash`, so a bump rewrites every context row. */
export const CONTEXT_VERSION = 'ctc-ctx-1';

export const contextLimits = {
  /** FROM-SPEC (spec:282 "files > 1 MB"): JavaScript string length of `content`; equal is valid, more is `too_large`. */
  maxFileChars: 1_048_576,
  /** chosen by judgment: bounds the rows of one document; the first nodes in line order are kept. */
  maxNodesPerFile: 2000,
  /** chosen by judgment: code references kept per task or decision. */
  maxRefsPerNode: 20,
  /** chosen by judgment: distinct targets per capability or workflow step. */
  maxCapabilityRefs: 50,
  /** chosen by judgment: workflow steps read from one workflow file. */
  maxWorkflowNodes: 200,
  /** chosen by judgment: code points of a capability description kept in `meta.description`. */
  maxDescription: 300,
  /** FROM-SPEC (spec:287): code points of embed text per node. */
  maxEmbedText: 2000,
  /** chosen by judgment: edges accepted from one model reply. */
  maxModelEdges: 100,
  /** chosen by judgment: code points of document text in the extract prompt. */
  maxPromptChars: 40_000,
};
