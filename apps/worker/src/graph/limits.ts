/** Module constants of the graph job, read at call time so a test can assign to them and restore them. Values: DECISIONS D2. */
export const graphLimits = {
  /** FROM-SPEC (spec:282 "files > 1 MB"): inclusive, a file of exactly this size is read. */
  maxFileBytes: 1_048_576,
  /** chosen by judgment: bounds one walk; a truncated walk deletes nothing. */
  maxFiles: 20_000,
  /** chosen by judgment: more `payload.files` entries than this turn the job into a full walk. */
  maxPayloadFiles: 1000,
  /** chosen by judgment: a file that loses fewer nodes than this is never refused by the shrink guard. */
  shrinkMinLoss: 3,
  /** FROM-SPEC (spec:287): texts per embed call. */
  embedBatch: 32,
  /** FROM-SPEC (spec:287): code points of embed text per node. */
  embedTextChars: 2000,
  /** chosen by judgment: package.json files read per rebuild for specifier resolution. */
  maxPackageJson: 200,
  /** chosen by judgment: entries per list in the job result (counts stay exact). */
  resultListMax: 100,
};

/** Synthetic source file that owns every external package node (D18); a root-level file with this name is never walked (D9). */
export const PACKAGES_SOURCE = '<packages>';
