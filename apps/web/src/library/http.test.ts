import { ConflictError, RepoError, StoreTimeoutError } from '@ctc/shared/repositories';
import { LabelsBody } from '@ctc/shared/schemas/library';
import { describe, expect, it } from 'vitest';
import { ApiError, errorBody, parse, statusOf, toApiError } from './http.ts';
import { unsafeManifestPath } from './restore.ts';

describe('error model (D3)', () => {
  it('maps repo errors by code and everything else to internal with the class name only', () => {
    expect(toApiError(new RepoError('not_found', 'x')).code).toBe('not_found');
    expect(statusOf(toApiError(new ConflictError('x')))).toBe(409);
    expect(statusOf(toApiError(new StoreTimeoutError()))).toBe(504);
    expect(errorBody(toApiError(new TypeError('secret')))).toEqual({ error: { code: 'internal', message: 'TypeError' } });
    expect(errorBody(toApiError('boom'))).toEqual({ error: { code: 'internal', message: 'string' } });
  });
  it('statuses: invalid 422, ambiguous 409', () => {
    expect([statusOf(new ApiError('invalid', 'm')), statusOf(new ApiError('ambiguous', 'm')), statusOf(new ApiError('internal', 'm'))]).toEqual([422, 409, 500]);
  });
  it('parse reports the first issue with the request part in front of the path', () => {
    try {
      parse(LabelsBody, 'body', { labels: ['ok', 'Bad Label'] });
      expect.unreachable();
    } catch (e) {
      expect(errorBody(toApiError(e)).error).toMatchObject({ code: 'invalid', path: ['body', 'labels', 1] });
    }
  });
});

describe('unsafeManifestPath (D1e)', () => {
  it('refuses absolute, empty-segment, dot, hidden and NUL paths', () => {
    for (const p of ['/etc/x', '', 'a//b', 'a/./b', '../x', 'a/../b', '.env', '.git/hooks/x', 'a/.hidden', 'a\0b', 'a\\b']) expect(unsafeManifestPath(p)).toBe(true);
  });
  it('accepts ordinary relative paths', () => {
    for (const p of ['SKILL.md', 'scripts/run.sh', 'docs/a-b_c.md']) expect(unsafeManifestPath(p)).toBe(false);
  });
});
