/** Module constants of the context jobs, read at call time so a test can assign to them and restore them. Values: DECISIONS D2. */
export const contextWorkerLimits = {
  /** chosen by judgment: more `payload.files` entries than this turn the pass into a full walk (same rule and number as T2.2). */
  maxPayloadFiles: 1000,
  /** chosen by judgment: graph projects one capability is linked into. */
  maxProjects: 50,
  /** chosen by judgment: capabilities one sync links. */
  maxSyncCaps: 500,
  /** chosen by judgment: files one `graph.extract` job reads (one model call each). */
  maxExtractFiles: 10,
  /** chosen by judgment: extract jobs one context pass submits. */
  maxExtractSubmit: 20,
  /** chosen by judgment: `graph.extract` has no timer (spec:196), so the child process is bounded here. */
  extractTimeoutMs: 120_000,
  /** chosen by judgment: characters of model reply read from the child process. */
  extractMaxReplyChars: 200_000,
  /** chosen by judgment: entries per list in a job result (counts stay exact). */
  resultListMax: 100,
};
