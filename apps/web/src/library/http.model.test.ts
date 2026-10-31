import { describe, expect, it } from 'vitest';
import { ApiError, errorBody, statusOf } from './http.ts';

describe('http model_unavailable (T5.1 D23)', () => {
  it('is 503 and keeps the other codes', () => {
    expect(statusOf(new ApiError('model_unavailable', 'x'))).toBe(503);
    expect(errorBody(new ApiError('model_unavailable', 'x'))).toEqual({ error: { code: 'model_unavailable', message: 'x' } });
    expect([statusOf(new ApiError('not_found', 'x')), statusOf(new ApiError('internal', 'x')), statusOf(new ApiError('store_timeout', 'x'))]).toEqual([404, 500, 504]);
  });
});
