/** Typed errors of the repository module. Messages never carry row data, ids of other users or the connection URL. */

export type RepoErrorCode = 'conflict' | 'not_found' | 'invalid' | 'store_timeout';

/** Base class of every error this module raises on purpose; callers map `code` to an HTTP status. */
export class RepoError extends Error {
  readonly code: RepoErrorCode;
  readonly detail: string | undefined;

  constructor(code: RepoErrorCode, message: string, detail?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** Version or label race, illegal state transition, unique-index violation on a one-running-run rule. */
export class ConflictError extends RepoError {
  constructor(message: string, detail?: string) {
    super('conflict', message, detail);
  }
}

/** Postgres `57014` (statement timeout / query canceled). */
export class StoreTimeoutError extends RepoError {
  constructor(message = 'statement timeout', detail?: string) {
    super('store_timeout', message, detail);
  }
}
