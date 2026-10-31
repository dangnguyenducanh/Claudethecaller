import { describe, expect, it } from 'vitest';
import { devRefusal, isRefusal, namespaceOf, schemaOf } from './guards.ts';

const ok = { port: 18410, database_url: 'postgresql://postgres:pw@127.0.0.1:18304/postgres', redis_url: 'redis://127.0.0.1:18395/0' };

describe('devRefusal (D6)', () => {
  it('accepts the scratch services on the first and last dev port', () => {
    expect(devRefusal(ok)).toBeNull();
    expect(devRefusal({ ...ok, port: 18400 })).toBeNull();
    expect(devRefusal({ ...ok, port: 18499 })).toBeNull();
  });

  it('refuses a port one outside the range, naming the port', () => {
    expect(devRefusal({ ...ok, port: 18399 })).toEqual({ setting: 'port', reason: 'port 18399 is outside 18400-18499' });
    expect(devRefusal({ ...ok, port: 18500 })?.setting).toBe('port');
  });

  it('refuses another database or Redis without printing the URL or the password', () => {
    const db = devRefusal({ ...ok, database_url: 'postgresql://u:secretpw@10.255.255.1:5432/x' });
    const redis = devRefusal({ ...ok, redis_url: 'redis://:secretpw@127.0.0.1:18303/0' });
    expect([db?.setting, redis?.setting]).toEqual(['database_url', 'redis_url']);
    expect(JSON.stringify([db, redis])).not.toContain('secretpw');
    expect(devRefusal({ ...ok, redis_url: 'not a url' })?.setting).toBe('redis_url');
  });
});

describe('env values (D7)', () => {
  it('defaults the schema to ctc and the namespace to empty', () => {
    expect(schemaOf({})).toEqual({ schema: 'ctc' });
    expect(namespaceOf({})).toBe('');
    expect(namespaceOf({ CTC_REDIS_NAMESPACE: 'x:' })).toBe('x:');
  });

  it('refuses a schema createDb would refuse, naming CTC_DB_SCHEMA', () => {
    const bad = schemaOf({ CTC_DB_SCHEMA: 'Bad;Schema' });
    expect(isRefusal(bad) && bad.setting).toBe('CTC_DB_SCHEMA');
    expect(schemaOf({ CTC_DB_SCHEMA: 'a'.repeat(41) })).toEqual({ schema: 'a'.repeat(41) });
    expect(isRefusal(schemaOf({ CTC_DB_SCHEMA: 'a'.repeat(42) }))).toBe(true);
  });
});
